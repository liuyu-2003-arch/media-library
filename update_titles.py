#!/usr/bin/env python3
"""更新电影中文标题"""
import urllib.request
import json

API = "https://media-library-api.jemchmi.workers.dev"

# 中文标题映射 (id -> 中文名)
CHINESE_TITLES = {
    "36314193": "惊声尖叫7",
    "35064920": "拯救地球",
    "36926954": "杀的就是你",
    "36367195": "家弑服务",
}

def get_movies():
    with urllib.request.urlopen(f"{API}/api/movies") as resp:
        return json.loads(resp.read())["movies"]

def delete_movie(id):
    req = urllib.request.Request(f"{API}/api/movies/{id}", method="DELETE")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def add_movie(douban_url, search_query):
    data = json.dumps({"doubanUrl": douban_url, "searchQuery": search_query}).encode()
    req = urllib.request.Request(
        f"{API}/api/movies",
        data=data,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def main():
    movies = get_movies()
    
    for mid, chinese_title in CHINESE_TITLES.items():
        # Find movie with this id
        movie = next((m for m in movies if m["id"] == mid), None)
        if not movie:
            print(f"Movie {mid} not found, skipping")
            continue
            
        if movie.get("title_cn") == chinese_title:
            print(f"{chinese_title}: already correct")
            continue
            
        print(f"Updating {movie.get('title_cn')} -> {chinese_title}...")
        
        # Delete old entry
        delete_movie(mid)
        print(f"  Deleted {mid}")
        
        # Re-add with correct Chinese search query
        result = add_movie(
            f"https://movie.douban.com/subject/{mid}/",
            chinese_title
        )
        print(f"  Re-added as {result.get('movie', {}).get('title_cn', '?')}")

if __name__ == "__main__":
    main()