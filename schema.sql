-- Media Library Database Schema

CREATE TABLE IF NOT EXISTS movies (
    id TEXT PRIMARY KEY,
    douban_id TEXT UNIQUE NOT NULL,
    douban_url TEXT NOT NULL,
    title TEXT NOT NULL,
    title_cn TEXT,
    year TEXT,
    type TEXT CHECK(type IN ('movie', 'tv')) DEFAULT 'movie',
    rating TEXT,
    genre TEXT,
    director TEXT,
    cast TEXT,
    intro TEXT,
    poster TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movie_id TEXT NOT NULL,
    url TEXT NOT NULL,
    name TEXT,
    source TEXT DEFAULT '91panta',
    verified INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
    UNIQUE(movie_id, url)
);

CREATE INDEX idx_movies_douban_id ON movies(douban_id);
CREATE INDEX idx_movies_type ON movies(type);
CREATE INDEX idx_resources_movie_id ON resources(movie_id);
