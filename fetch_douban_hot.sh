#!/bin/bash
# 从豆瓣榜单自动拉取热门电影
# 用法: ./fetch_douban_hot.sh [--dry-run]

DRY_RUN=""
if [ "$1" = "--dry-run" ]; then
  DRY_RUN=1
fi

TMDB_TOKEN="eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlYWVlZmU1NTQ5YWZjMjNiODMwYjNmYTllZmI2ZDJmMyIsIm5iZiI6MTcyNDEzNTY0OC4zNDUsInN1YiI6IjY2YzQzOGUwZDIwMzM4ODQ1ODFhYzkzNiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.xsJCaik30sTIpcxFztO2Ql_GtOdlsqJJMsZlcbdXWhk"
D1_ACCOUNT="dd0afffd8fff1c8846db83bc10e2aa1f"
D1_DB="b414bdb1-dbda-4489-9d72-c7c0c738bb3a"
CF_TOKEN="cfut_h4fG1Oteo850bmdOr737ENdyTQU5oJlLaRD7q8zGa1a4edd6"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始拉取豆瓣热门电影..."

# 获取豆瓣榜单页面
# 豆瓣explore页面是JS渲染的，用chart榜单代替
HTML=$(curl -s "https://movie.douban.com/chart" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")

# 提取电影ID（去重）
MOVIE_IDS=$(echo "$HTML" | grep -o '/subject/[0-9]*' | sort -u | sed 's|/subject/||' | head -30)

echo "找到 $(echo "$MOVIE_IDS" | wc -l) 部电影"

# 获取已有的电影ID
EXISTING=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$D1_ACCOUNT/d1/database/$D1_DB/query" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT douban_id FROM movies"}' | python3 -c "import sys,json; print(' '.join([r[0] for r in json.load(sys.stdin).get('results',[])]))")

echo "数据库已有: $(echo $EXISTING | wc -w) 部电影"

# 处理每部电影
COUNT=0
for MID in $MOVIE_IDS; do
  # 检查是否已存在
  if echo "$EXISTING" | grep -q "$MID"; then
    continue
  fi
  
  echo "处理: $MID"
  
  if [ -n "$DRY_RUN" ]; then
    echo "  [预览模式] 将会添加 $MID"
    continue
  fi
  
  # 用豆瓣ID作为电影名搜索TMDB
  # 先获取豆瓣信息获取电影名
  DOUBAN_INFO=$(curl -s "https://movie.douban.com/subject/$MID/" \
    -H "User-Agent: Mozilla/5.0")
  
  MOVIE_NAME=$(echo "$DOUBAN_INFO" | grep -o '<span property="v:itemreviewed">[^<]*</span>' | sed 's/<[^>]*>//g' | head -1)
  
  if [ -z "$MOVIE_NAME" ]; then
    echo "  ⚠️ 无法获取电影名，跳过"
    continue
  fi
  
  echo "  电影名: $MOVIE_NAME"
  
  # 搜索TMDB
  TMDB_RESULT=$(curl -s "https://api.tmdb.org/3/search/movie?query=$(echo "$MOVIE_NAME" | sed 's/ /%20/g')" \
    -H "Authorization: Bearer $TMDB_TOKEN")
  
  TMDB_ID=$(echo "$TMDB_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['results'][0]['id'] if d.get('results') else '')" 2>/dev/null)
  
  if [ -z "$TMDB_ID" ]; then
    echo "  ⚠️ TMDB未找到"
    continue
  fi
  
  echo "  TMDB ID: $TMDB_ID"
  
  # 获取TMDB详情
  TMDB_DETAIL=$(curl -s "https://api.tmdb.org/3/movie/$TMDB_ID" \
    -H "Authorization: Bearer $TMDB_TOKEN")
  
  TMDB_RATING=$(echo "$TMDB_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(round(d.get('vote_average',0),1))" 2>/dev/null)
  IMDB_ID=$(echo "$TMDB_DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('imdb_id',''))" 2>/dev/null)
  POSTER=$(echo "$TMDB_DETAIL" | python3 -c "import sys,json; p=json.load(sys.stdin).get('poster_path',''); print('https://image.tmdb.org/t/p/original'+p if p else '')" 2>/dev/null)
  YEAR=$(echo "$TMDB_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin).get('release_date',''); print(d[:4] if d else '')" 2>/dev/null)
  GENRE=$(echo "$TMDB_DETAIL" | python3 -c "import sys,json; g=json.load(sys.stdin).get('genres',[]); print(' / '.join([x['name'] for x in g]))" 2>/dev/null)
  INTRO=$(echo "$TMDB_DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('overview',''))" 2>/dev/null)
  
  # 获取演员
  TMDB_CREDITS=$(curl -s "https://api.tmdb.org/3/movie/$TMDB_ID/credits" \
    -H "Authorization: Bearer $TMDB_TOKEN")
  
  CAST=$(echo "$TMDB_CREDITS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cast=d.get('cast',[])[:8]
names=[c['name'] for c in cast]
print(', '.join(names))
" 2>/dev/null)
  
  DIRECTOR=$(echo "$TMDB_CREDITS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
crew=[c['name'] for c in d.get('crew',[]) if c.get('job')=='Director']
print(', '.join(crew))
" 2>/dev/null)
  
  # 添加到数据库
  RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$D1_ACCOUNT/d1/database/$D1_DB/query" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"sql\":\"INSERT OR IGNORE INTO movies (id, douban_id, douban_url, title, title_cn, year, type, tmdb_rating, imdb_id, genre, director, cast, intro, poster, tmdb_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\", \"params\":[\"$MID\",\"$MID\",\"https://movie.douban.com/subject/$MID/\",\"$MOVIE_NAME\",\"$MOVIE_NAME\",\"$YEAR\",\"movie\",\"$TMDB_RATING\",\"$IMDB_ID\",\"$GENRE\",\"$DIRECTOR\",\"$CAST\",\"$INTRO\",\"$POSTER\",\"$TMDB_ID\"]}")
  
  if echo "$RESULT" | python3 -c "import sys,json; sys.exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
    echo "  ✅ 添加成功"
    COUNT=$((COUNT+1))
  else
    echo "  ❌ 添加失败"
  fi
  
  sleep 0.3
done

echo ""
echo "完成！新增 $COUNT 部电影"
