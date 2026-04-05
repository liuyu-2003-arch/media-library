#!/bin/bash
# 从TMDB同步电影信息到数据库
# 用法: ./sync_from_tmdb.sh <豆瓣ID或电影名> [TMDB_ID]

TMDB_TOKEN="eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlYWVlZmU1NTQ5YWZjMjNiODMwYjNmYTllZmI2ZDJmMyIsIm5iZiI6MTcyNDEzNTY0OC4zNDUsInN1YiI6IjY2YzQzOGUwZDIwMzM4ODQ1ODFhYzkzNiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.xsJCaik30sTIpcxFztO2Ql_GtOdlsqJJMsZlcbdXWhk"
D1_ACCOUNT="dd0afffd8fff1c8846db83bc10e2aa1f"
D1_DB="b414bdb1-dbda-4489-9d72-c7c0c738bb3a"
CF_TOKEN="cfut_h4fG1Oteo850bmdOr737ENdyTQU5oJlLaRD7q8zGa1a4edd6"

QUERY="$1"
TMDB_ID="$2"

if [ -z "$QUERY" ]; then
    echo "用法: $0 <搜索词> [TMDB_ID]"
    exit 1
fi

# 如果没有提供TMDB_ID，搜索
if [ -z "$TMDB_ID" ]; then
    echo "搜索 TMDB: $QUERY"
    RESULT=$(curl -s "https://api.tmdb.org/3/search/movie?query=$(echo "$QUERY" | sed 's/ /%20/g')" \
        -H "Authorization: Bearer $TMDB_TOKEN")
    TMDB_ID=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['results'][0]['id'] if d['results'] else '')")
    
    if [ -z "$TMDB_ID" ]; then
        echo "未找到 TMDB 结果"
        exit 1
    fi
    echo "找到 TMDB ID: $TMDB_ID"
fi

# 获取电影详情
echo "获取电影详情..."
MOVIE=$(curl -s "https://api.tmdb.org/3/movie/$TMDB_ID" -H "Authorization: Bearer $TMDB_TOKEN")

TITLE=$(echo "$MOVIE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title',''))")
ORIGINAL_TITLE=$(echo "$MOVIE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('original_title',''))")
POSTER=$(echo "$MOVIE" | python3 -c "import sys,json; p=json.load(sys.stdin).get('poster_path',''); print('https://image.tmdb.org/t/p/original'+p if p else '')")
BACKDROP=$(echo "$MOVIE" | python3 -c "import sys,json; b=json.load(sys.stdin).get('backdrop_path',''); print('https://image.tmdb.org/t/p/original'+b if b else '')")
OVERVIEW=$(echo "$MOVIE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('overview',''))")
RUNTIME=$(echo "$MOVIE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('runtime',''))")
TMDB_RATING=$(echo "$MOVIE" | python3 -c "import sys,json; r=json.load(sys.stdin).get('vote_average',''); print(round(r,1) if r else '')")
IMDB_ID=$(echo "$MOVIE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('imdb_id',''))")
YEAR=$(echo "$MOVIE" | python3 -c "import sys,json; d=json.load(sys.stdin).get('release_date',''); print(d[:4] if d else '')")
GENRES=$(echo "$MOVIE" | python3 -c "import sys,json; g=json.load(sys.stdin).get('genres',[]); print(' / '.join([x['name'] for x in g]))")

echo "标题: $TITLE"
echo "海报: $POSTER"
echo "评分: $TMDB_RATING"

# 获取演员
echo "获取演员..."
CREDITS=$(curl -s "https://api.tmdb.org/3/movie/$TMDB_ID/credits" -H "Authorization: Bearer $TMDB_TOKEN")
CAST=$(echo "$CREDITS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cast = d.get('cast',[])[:8]
names = [c['name'] for c in cast]
profiles = [c.get('profile_path','') for c in cast]
print(';'.join(names))
")
CAST_DATA=$(echo "$CREDITS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cast = d.get('cast',[])[:8]
print(json.dumps([{'name':c['name'],'profile_path':c.get('profile_path','')} for c in cast]))
")

echo "演员: $CAST"

# 更新数据库
echo "更新数据库..."
QUERY_JSON=$(cat <<EOJ
{"sql":"UPDATE movies SET title=?, title_cn=?, poster=?, tmdb_id=?, imdb_id=?, tmdb_rating=?, intro=?, genre=?, cast=?, cast_data=? WHERE douban_url LIKE ?", "params":["$ORIGINAL_TITLE","$TITLE","$POSTER","$TMDB_ID","$IMDB_ID","$TMDB_RATING","$OVERVIEW","$GENRES","$CAST","$CAST_DATA","%$QUERY%"]}
EOJ
)

echo "$QUERY_JSON" | curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$D1_ACCOUNT/d1/database/$D1_DB/query" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    -d @-

echo ""
echo "✅ 完成！"
