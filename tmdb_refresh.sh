#!/bin/bash
# TMDB 电影数据自动刷新脚本 v2
# 每天凌晨执行，检查数据库中电影的最新信息（包括导演头像）

# 配置
TMDB_API_KEY="1cf5ae654a8ca4bc38c290add42c8a3e"
CF_ACCOUNT_ID="dd0afffd8fff1c8846db83bc10e2aa1f"
CF_D1_TOKEN="cfut_h4fG1Oteo850bmdOr737ENdyTQU5oJlLaRD7q8zGa1a4edd6"
DATABASE_ID="b414bdb1-dbda-4489-9d72-c7c0c738bb3a"

# R2 配置（海报）
R2_TOKEN="cfut_MX0SBiLmwfZXTxtR1ksqFAlM557rWxqKMR513ne7e851e9b6"
R2_ACCOUNT="dd0afffd8fff1c8846db83bc10e2aa1f"
BUCKET="cloud-r2"
R2_PUBLIC_URL="https://pub-53636cd060c94f6190dae2c201d6c7c2.r2.dev"

# 日志
LOG_FILE="/Users/yuliu/.openclaw/workspace/logs/tmdb_refresh.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# 查询数据库中的电影
query_db() {
    local sql="$1"
    curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/$DATABASE_ID/query" \
        -H "Authorization: Bearer $CF_D1_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"sql\":\"$sql\"}"
}

# 上传海报到 R2
upload_poster() {
    local tmdb_id="$1"
    local poster_path="$2"
    local movie_id="$3"
    
    if [ -z "$poster_path" ]; then
        return 1
    fi
    
    # 下载海报
    local poster_url="https://image.tmdb.org/t/p/w500$poster_path"
    local temp_file="/tmp/poster_${movie_id}.jpg"
    
    curl -sL "$poster_url" -o "$temp_file" 2>/dev/null
    
    if [ -s "$temp_file" ]; then
        # 上传到 R2
        local r2_key="poster_${movie_id}.jpg"
        local result=$(curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$R2_ACCOUNT/r2/buckets/$BUCKET/objects/$r2_key" \
            -H "Authorization: Bearer $R2_TOKEN" \
            -H "Content-Type: image/jpeg" \
            --data-binary @"$temp_file")
        
        rm -f "$temp_file"
        
        if echo "$result" | grep -q '"success": true'; then
            echo "${R2_PUBLIC_URL}/${r2_key}"
            return 0
        fi
    fi
    
    rm -f "$temp_file"
    return 1
}

# 主流程
log "========== TMDB 刷新开始 =========="

# 获取数据库中所有电影
log "获取数据库电影列表..."
movies=$(query_db "SELECT id, tmdb_id, title, director FROM movies WHERE tmdb_id IS NOT NULL AND tmdb_id != '' AND tmdb_id NOT LIKE '999999%'")

# 解析 movies
echo "$movies" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('result', [{}])[0].get('results', [])
for r in results:
    print(r.get('id', ''), r.get('tmdb_id', ''), r.get('title', ''), r.get('director', ''))
" 2>/dev/null | while read db_id tmdb_id title director; do
    if [ -n "$tmdb_id" ] && [ "$tmdb_id" != "None" ]; then
        log "检查电影 $title (TMDB: $tmdb_id)..."
        
        # 获取 TMDB 数据
        info=$(curl -s "https://api.themoviedb.org/3/movie/$tmdb_id?api_key=$TMDB_API_KEY")
        credits=$(curl -s "https://api.themoviedb.org/3/movie/$tmdb_id/credits?api_key=$TMDB_API_KEY")
        
        # 解析电影信息
        title=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title','') or '')" 2>/dev/null)
        overview=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('overview','') or '')[:500])" 2>/dev/null)
        rating=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('vote_average',0))" 2>/dev/null)
        poster_path=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('poster_path','') or '')" 2>/dev/null)
        
        # 解析导演信息
        director_data=$(echo "$credits" | python3 -c "
import sys,json
d=json.load(sys.stdin)
directors = [p for p in d.get('crew',[]) if p.get('job') == 'Director']
result = []
for p in directors[:3]:
    result.append({'name': p.get('name',''), 'profile_path': p.get('profile_path')})
print(json.dumps(result))
" 2>/dev/null)
        
        if [ -n "$title" ]; then
            # 转义
            title_escaped=${title//\'/\'}
            overview_escaped=${overview//\'/\'}
            
            # 上传新海报到 R2
            new_poster=""
            if [ -n "$poster_path" ]; then
                new_poster=$(upload_poster "$tmdb_id" "$poster_path" "$db_id")
            fi
            
            # 构建更新 SQL
            if [ -n "$new_poster" ]; then
                update_sql="UPDATE movies SET title = '$title_escaped', overview = '$overview_escaped', poster = '$new_poster', rating = $rating, director_data = '$director_data', updated_at = datetime('now') WHERE id = '$db_id'"
            else
                update_sql="UPDATE movies SET title = '$title_escaped', overview = '$overview_escaped', rating = $rating, director_data = '$director_data', updated_at = datetime('now') WHERE id = '$db_id'"
            fi
            
            update_result=$(query_db "$update_sql")
            
            if echo "$update_result" | grep -q '"success": true'; then
                log "✅ $title 更新成功 (评分: $rating)"
            else
                log "❌ $title 更新失败"
            fi
        else
            log "⚠️  $tmdb_id 无数据（可能是API限制）"
        fi
    fi
done

log "========== TMDB 刷新完成 =========="
