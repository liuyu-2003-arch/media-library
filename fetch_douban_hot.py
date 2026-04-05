#!/usr/bin/env python3
"""
从豆瓣热门电影页面自动拉取电影到数据库
支持手动运行和定时任务

用法:
    python3 fetch_douban_hot.py          # 手动运行
    python3 fetch_douban_hot.py --dry-run # 预览不添加
"""

import json
import re
import sys
import urllib.request
import urllib.parse
import time
from datetime import datetime

# 配置
TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlYWVlZmU1NTQ5YWZjMjNiODMwYjNmYTllZmI2ZDJmMyIsIm5iZiI6MTcyNDEzNTY0OC4zNDUsInN1YiI6IjY2YzQzOGUwZDIwMzM4ODQ1ODFhYzkzNiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.xsJCaik30sTIpcxFztO2Ql_GtOdlsqJJMsZlcbdXWhk"
D1_ACCOUNT = "dd0afffd8fff1c8846db83bc10e2aa1f"
D1_DB = "b414bdb1-dbda-4489-9d72-c7c0c738bb3a"
CF_TOKEN = "cfut_h4fG1Oteo850bmdOr737ENdyTQU5oJlLaRD7q8zGa1a4edd6"

DOU BAN_URL = "https://movie.douban.com/explore?support_type=movie&is_all=false&category=%E7%83%AD%E9%97%A8&type=%E5%85%A8%E9%83%A8"

def fetch_douban_page():
    """获取豆瓣热门电影页面"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    
    try:
        req = urllib.request.Request(DOUBAN_URL, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode('utf-8')
    except Exception as e:
        print(f"获取豆瓣页面失败: {e}")
        return None

def parse_movie_ids(html):
    """从页面提取电影ID和名称"""
    # 匹配 /subject/12345678/ 格式的链接
    pattern = r'/subject/(\d+)/'
    ids = set(re.findall(pattern, html))
    
    # 尝试提取电影名称
    names = {}
    title_pattern = r'<a[^>]+href="/subject/(\d+)/"[^>]*>([^<]+)</a>'
    for match in re.finditer(title_pattern, html):
        movie_id, title = match.groups()
        if movie_id in ids:
            names[movie_id] = title.strip()
    
    return list(ids), names

def search_tmdb(query):
    """搜索TMDB"""
    url = f"https://api.tmdb.org/3/search/movie?query={urllib.parse.quote(query)}"
    try:
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TMDB_TOKEN}'})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            if data.get('results'):
                return data['results'][0]['id']
    except Exception as e:
        print(f"TMDB搜索失败: {e}")
    return None

def get_existing_ids():
    """获取数据库中已有的电影ID"""
    data = json.dumps({"sql": "SELECT douban_id FROM movies"}).encode()
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{D1_ACCOUNT}/d1/database/{D1_DB}/query",
        data=data,
        headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            if result.get('success'):
                return set(row[0] for row in result.get('results', []))
    except Exception as e:
        print(f"获取已有电影失败: {e}")
    return set()

def add_movie_to_db(douban_id, tmdb_id, search_name):
    """添加电影到数据库"""
    # 获取TMDB详情
    url = f"https://api.tmdb.org/3/movie/{tmdb_id}"
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TMDB_TOKEN}'})
    with urllib.request.urlopen(req) as resp:
        details = json.loads(resp.read())
    
    # 获取演员
    credits_url = f"https://api.tmdb.org/3/movie/{tmdb_id}/credits"
    credits_req = urllib.request.Request(credits_url, headers={'Authorization': f'Bearer {TMDB_TOKEN}'})
    with urllib.request.urlopen(credits_req) as resp:
        credits = json.loads(resp.read())
    
    cast_list = (credits.get('cast', [])[:8])
    cast_data = [{'name': c['name'], 'profile_path': c.get('profile_path', '')} for c in cast_list]
    cast_names = ', '.join([c['name'] for c in cast_list])
    
    directors = [c['name'] for c in credits.get('crew', []) if c.get('job') == 'Director']
    director = ', '.join(directors)
    
    genres = ' / '.join([g['name'] for g in details.get('genres', [])])
    poster = f"https://image.tmdb.org/t/p/original{details['poster_path']}" if details.get('poster_path') else ''
    tmdb_rating = str(round(details.get('vote_average', 0), 1))
    imdb_id = details.get('imdb_id', '')
    year = details.get('release_date', '')[:4] if details.get('release_date') else ''
    intro = details.get('overview', '')
    
    # 插入数据库
    insert_data = {
        "sql": """INSERT OR IGNORE INTO movies 
            (id, douban_id, douban_url, title, title_cn, year, type, rating, tmdb_rating, imdb_id, genre, director, cast, cast_data, intro, poster, tmdb_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        "params": [
            douban_id, douban_id, 
            f"https://movie.douban.com/subject/{douban_id}/",
            details.get('original_title', '') or details.get('title', ''),
            details.get('title', ''),
            year, 'movie', '', tmdb_rating, imdb_id, genres, director, cast_names,
            json.dumps(cast_data, ensure_ascii=False), intro, poster, str(tmdb_id)
        ]
    }
    
    data = json.dumps(insert_data).encode()
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{D1_ACCOUNT}/d1/database/{D1_DB}/query",
        data=data,
        headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
    )
    
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        return result.get('success', False)

def main():
    dry_run = '--dry-run' in sys.argv
    
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 开始拉取豆瓣热门电影...")
    
    # 获取页面
    html = fetch_douban_page()
    if not html:
        print("获取页面失败，退出")
        sys.exit(1)
    
    # 提取电影ID
    movie_ids, movie_names = parse_movie_ids(html)
    print(f"页面中找到 {len(movie_ids)} 部电影")
    
    # 获取已有的电影ID
    existing_ids = get_existing_ids()
    print(f"数据库中已有 {len(existing_ids)} 部电影")
    
    # 找出需要添加的新电影
    new_ids = [mid for mid in movie_ids if mid not in existing_ids]
    print(f"需要添加 {len(new_ids)} 部新电影")
    
    if dry_run:
        print("=== 预览模式，不实际添加 ===")
        for mid in new_ids[:10]:
            print(f"  - {mid}: {movie_names.get(mid, '未知')}")
        return
    
    # 添加新电影
    added = 0
    for i, mid in enumerate(new_ids):
        name = movie_names.get(mid, mid)
        print(f"[{i+1}/{len(new_ids)}] 处理: {name} (豆瓣ID: {mid})")
        
        # 搜索TMDB
        tmdb_id = search_tmdb(name)
        if not tmdb_id:
            print(f"  ⚠️ TMDB未找到，跳过")
            continue
        
        print(f"  ✓ TMDB ID: {tmdb_id}")
        
        # 添加到数据库
        if add_movie_to_db(mid, tmdb_id, name):
            print(f"  ✅ 添加成功")
            added += 1
        else:
            print(f"  ❌ 添加失败")
        
        time.sleep(0.5)  # 避免请求太快
    
    print(f"\n完成！新增 {added} 部电影")

if __name__ == "__main__":
    main()
