#!/bin/bash
# TMDB 电影数据自动刷新脚本
# 每天凌晨执行，检查数据库中电影的最新信息

# 配置
TMDB_API_KEY="2d8e0e6b7a5e3b7c9f4d6e8f1a2b3c4d"
CF_ACCOUNT_ID="dd0afffd8fff1c8846db83bc10e2aa1f"
CF_D1_TOKEN="cfut_h4fG1Oteo850bmdOr737ENdyTQU5oJlLaRD7q8zGa1a4edd6"
DATABASE_ID="b414bdb1-dbda-4489-9d72-c7c0c738bb3a"

# R2 配置（海报）
R2_TOKEN="cfut_MX0SBiLmwfZXTxtR1ksqFAlM557rWxqKMR513ne7e851e9b6"
R2_ACCOUNT="dd0afffd8fff1c8846db83bc10e2aa1f"
BUCKET="cloud-r2"
R2_PUBLIC_URL="https://pub-53636cd060c94f6190dae2c201d6c7c2.r2.dev"

# 日志
LOG_FILE="/tmp/tmdb_refresh.log"

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

# 更新数据库
update_db() {
    local movie_id="$1"
    local title="$2"
    local overview="$3"
    local poster="$4"
    local rating="$5"
    
    # 转义单引号
    title="${title//\'/\'}"
    overview="${overview//\'/\'}"
    
    query_db "UPDATE movies SET 
        title = '$title',
        overview = '$overview', 
        poster = '$poster',
        rating = $rating,
        updated_at = datetime('now')
        WHERE id = '$movie_id'" | grep -q '"success": true' && echo "OK" || echo "FAIL"
}

# 获取电影详细信息
fetch_tmdb() {
    local tmdb_id="$1"
    
    # 获取电影基本信息
    local info=$(curl -s "https://api.themoviedb.org/3/movie/$tmdb_id?api_key=$TMDB_API_KEY")
    local title=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title',''))" 2>/dev/null)
    local overview=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('overview','')[:500])" 2>/dev/null)
    local rating=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('vote_average',0))" 2>/dev/null)
    local poster_path=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('poster_path',''))" 2>/dev/null)
    
    echo "$title|$overview|$rating|$poster_path"
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
        
        if echo "$result" | grep -q '"success": true'; then
            echo "${R2_PUBLIC_URL}/${r2_key}"
        else
            rm -f "$temp_file"
            return 1
        fi
    fi
    
    rm -f "$temp_file"
    return 1
}

# 主流程
log "========== TMDB 刷新开始 =========="

# 获取数据库中所有电影
log "获取数据库电影列表..."
movies=$(query_db "SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL AND tmdb_id != '' AND tmdb_id NOT LIKE '999999%'")

# 解析 movies（这里简化处理）
echo "$movies" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('result', [{}])[0].get('results', [])
for r in results:
    print(r.get('id'), r.get('tmdb_id'))
" 2>/dev/null | while read db_id tmdb_id; do
    if [ -n "$tmdb_id" ] && [ "$tmdb_id" != "None" ]; then
        log "检查电影 TMDB ID: $tmdb_id..."
        
        # 获取 TMDB 数据
        data=$(curl -s "https://api.themoviedb.org/3/movie/$tmdb_id?api_key=$TMDB_API_KEY")
        
        title=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title',''))" 2>/dev/null)
        overview=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('overview','')[:500])" 2>/dev/null)
        rating=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('vote_average',0))" 2>/dev/null)
        poster_path=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('poster_path',''))" 2>/dev/null)
        
        if [ -n "$title" ]; then
            # 转义
            title_escaped=${title//\'/\'}
            overview_escaped=${overview//\'/\'}
            
            # 上传新海报到 R2
            if [ -n "$poster_path" ]; then
                new_poster=$(upload_poster "$tmdb_id" "$poster_path" "$db_id")
            else
                new_poster=""
            fi
            
            # 更新数据库
            if [ -n "$new_poster" ]; then
                update_result=$(query_db "UPDATE movies SET 
                    title = '$title_escaped',
                    overview = '$overview_escaped', 
                    poster = '$new_poster',
                    rating = $rating,
                    updated_at = datetime('now')
                    WHERE id = '$db_id'")
            else
                update_result=$(query_db "UPDATE movies SET 
                    title = '$title_escaped',
                    overview = '$overview_escaped', 
                    rating = $rating,
                    updated_at = datetime('now')
                    WHERE id = '$db_id'")
            fi
            
            if echo "$update_result" | grep -q '"success": true'; then
                log "✅ $title 更新成功 (评分: $rating)"
            else
                log "❌ $title 更新失败"
            fi
        fi
    fi
done

log "========== TMDB 刷新完成 =========="
