#!/usr/bin/env python3
"""
影视库添加工具
用法: python3 add_movie.py <douban_url>
"""

import json
import sys
import os
import re
import requests
from datetime import datetime

DATA_FILE = os.path.join(os.path.dirname(__file__), 'data.json')

def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_data(data):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def fetch_douban_info(url):
    """从豆瓣获取影视信息"""
    # 提取豆瓣ID
    match = re.search(r'subject/(\d+)', url)
    if not match:
        print("❌ 无法从URL提取豆瓣ID")
        return None
    
    douban_id = match.group(1)
    
    # 调用豆瓣API
    api_url = f"https://api.douban.com/v2/movie/subject/{douban_id}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json'
    }
    
    try:
        resp = requests.get(api_url, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            
            # 判断是电影还是剧集
            item_type = 'tv' if data.get('episodes_count') else 'movie'
            
            # 获取评分
            rating = data.get('rating', {})
            rating_value = rating.get('average', '')
            
            # 获取 genres
            genres = data.get('genres', [])
            genre_str = ' / '.join(genres) if genres else ''
            
            # 获取演员
            casts = data.get('casts', [])
            casts_str = ', '.join([c.get('name', '') for c in casts[:5] if c.get('name')])
            
            # 获取简介
            summary = data.get('summary', '')
            
            info = {
                'id': douban_id,
                'doubanId': douban_id,
                'doubanUrl': url,
                'title': data.get('title', ''),
                'titleCn': data.get('original_title', ''),
                'year': data.get('year', ''),
                'type': item_type,
                'rating': str(rating_value) if rating_value else '',
                'genre': genre_str,
                'director': ', '.join([d.get('name', '') for d in data.get('directors', []) if d.get('name')]),
                'cast': casts_str,
                'intro': summary,
                'poster': data.get('image', '').replace('s_ratio_poster', 'l_ratio_poster'),
                'resources': [],
                'addedAt': datetime.now().strftime('%Y-%m-%d %H:%M'),
                'updatedAt': datetime.now().strftime('%Y-%m-%d %H:%M')
            }
            
            return info
        else:
            print(f"❌ 豆瓣API返回错误: {resp.status_code}")
            return None
    except Exception as e:
        print(f"❌ 获取豆瓣信息失败: {e}")
        return None

def add_movie(douban_url):
    """添加影视到库"""
    print(f"📡 正在获取豆瓣信息: {douban_url}")
    
    info = fetch_douban_info(douban_url)
    if not info:
        sys.exit(1)
    
    data = load_data()
    
    # 检查是否已存在
    existing = next((i, m) for i, m in enumerate(data) if m.get('doubanId') == info['doubanId'])
    if existing:
        print(f"⚠️  已存在: {info['titleCn'] || info['title']}，更新信息...")
        data[existing[0]] = {**existing[1], **info, 'updatedAt': datetime.now().strftime('%Y-%m-%d %H:%M')}
    else:
        print(f"✅ 成功获取: {info['titleCn'] || info['title']}")
        data.insert(0, info)
    
    save_data(data)
    print(f"💾 已保存到数据库")

def add_resource(movie_id, resource_url, resource_name=''):
    """为影视添加资源链接"""
    data = load_data()
    
    for m in data:
        if m['id'] == movie_id:
            # 检查是否已存在相同链接
            for r in m.get('resources', []):
                if r['url'] == resource_url:
                    print(f"⚠️  资源链接已存在")
                    return
            
            m['resources'].append({
                'url': resource_url,
                'name': resource_name,
                'addedAt': datetime.now().strftime('%Y-%m-%d %H:%M')
            })
            m['updatedAt'] = datetime.now().strftime('%Y-%m-%d %H:%M')
            save_data(data)
            print(f"✅ 已添加资源链接到: {m['titleCn'] || m['title']}")
            return
    
    print(f"❌ 未找到影视ID: {movie_id}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    arg = sys.argv[1]
    
    if 'douban.com' in arg:
        add_movie(arg)
    elif len(sys.argv) >= 3:
        # add_resource <movie_id> <url> [name]
        add_resource(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '')
    else:
        print("❌ 参数格式错误")
        print(__doc__)
