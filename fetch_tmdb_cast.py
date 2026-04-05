#!/usr/bin/env python3
"""
从TMDB获取演员数据并更新数据库
用法: python3 fetch_tmdb_cast.py <豆瓣ID或电影名>
"""

import json
import sys
import urllib.request
import urllib.parse

TMDB_API_KEY = "1cf5ae654a8ca4bc38c290add42c8a3e"
D1_ACCOUNT = "dd0afffd8fff1c8846db83bc10e2aa1f"
D1_DB = "b414bdb1-dbda-4489-9d72-c7c0c738bb3a"
CF_TOKEN = "cfut_h4fG1Oteo850bmdOr737ENdyTQU5oJlLaRD7q8zGa1a4edd6"

def search_tmdb(query):
    """搜索TMDB电影"""
    url = f"https://api.tmdb.org/3/search/movie?api_key={TMDB_API_KEY}&query={urllib.parse.quote(query)}"
    try:
        with urllib.request.urlopen(url) as resp:
            data = json.loads(resp.read())
            if data.get('results'):
                return data['results'][0]['id']
    except Exception as e:
        print(f"搜索失败: {e}")
    return None

def get_credits(tmdb_id):
    """获取演员列表"""
    url = f"https://api.tmdb.org/3/movie/{tmdb_id}/credits?api_key={TMDB_API_KEY}"
    try:
        with urllib.request.urlopen(url) as resp:
            data = json.loads(resp.read())
            cast = []
            for actor in data.get('cast', [])[:8]:
                cast.append({
                    'name': actor['name'],
                    'profile_path': actor.get('profile_path')
                })
            return cast
    except Exception as e:
        print(f"获取演员失败: {e}")
    return []

def update_database(movie_id, cast_data):
    """更新数据库"""
    import sqlite3
    
    # 构建cast_data JSON
    cast_json = json.dumps(cast_data, ensure_ascii=False)
    
    # 直接调用Cloudflare D1 API
    data = json.dumps({
        "sql": "UPDATE movies SET cast_data = ? WHERE id = ?",
        "params": [cast_json, str(movie_id)]
    }).encode()
    
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{D1_ACCOUNT}/d1/database/{D1_DB}/query",
        data=data,
        headers={
            "Authorization": f"Bearer {CF_TOKEN}",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            if result.get('success'):
                return True
    except Exception as e:
        print(f"更新失败: {e}")
    return False

def get_movie_from_db(movie_id):
    """从数据库获取电影信息"""
    data = json.dumps({
        "sql": "SELECT * FROM movies WHERE id = ?",
        "params": [str(movie_id)]
    }).encode()
    
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{D1_ACCOUNT}/d1/database/{D1_DB}/query",
        data=data,
        headers={
            "Authorization": f"Bearer {CF_TOKEN}",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            if result.get('success') and result.get('results'):
                return result['results'][0]
    except Exception as e:
        print(f"查询失败: {e}")
    return None

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    query = sys.argv[1]
    
    # 如果是数字，当作豆瓣ID处理
    if query.isdigit():
        movie = get_movie_from_db(query)
        if movie:
            # 用电影名搜索TMDB
            search_name = movie.get('title_cn') or movie.get('title') or query
            print(f"使用电影名搜索: {search_name}")
        else:
            print(f"未找到豆瓣ID: {query}")
            sys.exit(1)
    else:
        search_name = query
    
    # 搜索TMDB
    print(f"正在搜索TMDB: {search_name}")
    tmdb_id = search_tmdb(search_name)
    if not tmdb_id:
        print("未找到TMDB结果")
        sys.exit(1)
    
    print(f"找到TMDB ID: {tmdb_id}")
    
    # 获取演员
    print("正在获取演员数据...")
    cast = get_credits(tmdb_id)
    if not cast:
        print("未获取到演员数据")
        sys.exit(1)
    
    print(f"获取到 {len(cast)} 位演员")
    for actor in cast:
        print(f"  - {actor['name']}")
    
    # 更新数据库
    movie_id = query if query.isdigit() else None
    if not movie_id:
        # 搜索数据库找到对应电影
        pass
    
    if movie_id:
        if update_database(movie_id, cast):
            print(f"✅ 数据库已更新，豆瓣ID: {movie_id}")
        else:
            print("❌ 更新失败")

if __name__ == "__main__":
    main()
