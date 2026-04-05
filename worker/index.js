/**
 * Media Library API - Cloudflare Worker
 * 
 * Endpoints:
 * - GET /api/movies - List all movies
 * - POST /api/movies - Add movie from Douban URL (fetches data from TMDB)
 * - GET /api/movies/:id - Get movie details
 * - POST /api/movies/:id/resources - Search and add resources
 * - DELETE /api/movies/:id - Delete movie
 */

const PANTALIST_URL = 'http://91panta.cn/';
const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlYWVlZmU1NTQ5YWZjMjNiODMwYjNmYTllZmI2ZDJmMyIsIm5iZiI6MTcyNDEzNTY0OC4zNDUsInN1YiI6IjY2YzQzOGUwZDIwMzM4ODQ1ODFhYzkzNiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.xsJCaik30sTIpcxFztO2Ql_GtOdlsqJJMsZlcbdXWhk';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route: GET /api/movies
      if (path === '/api/movies' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM movies ORDER BY added_at DESC'
        ).all();
        return Response.json({ movies: results }, { headers: corsHeaders });
      }

      // Route: POST /api/movies - Add from Douban URL, fetch data from TMDB
      if (path === '/api/movies' && request.method === 'POST') {
        const { doubanUrl, searchQuery } = await request.json();
        
        if (!doubanUrl || !doubanUrl.includes('douban.com/subject/')) {
          return Response.json({ error: 'Invalid Douban URL' }, { status: 400 });
        }

        // Extract Douban ID
        const match = doubanUrl.match(/subject\/(\d+)/);
        if (!match) {
          return Response.json({ error: 'Cannot extract Douban ID' }, { status: 400 });
        }
        const doubanId = match[1];

        // Check if already exists
        const existing = await env.DB.prepare(
          'SELECT * FROM movies WHERE douban_id = ?'
        ).bind(doubanId).first();

        if (existing) {
          return Response.json({ movie: existing, status: 'already_exists' });
        }

        // Search TMDB with the movie name
        if (!searchQuery) {
          return Response.json({ error: 'searchQuery required (movie name for TMDB search)' }, { status: 400 });
        }

        const searchResp = await fetch(
          `https://api.tmdb.org/3/search/movie?query=${encodeURIComponent(searchQuery)}`,
          { headers: { 'Authorization': `Bearer ${TMDB_TOKEN}` } }
        );
        
        if (!searchResp.ok) {
          return Response.json({ error: 'TMDB search failed' }, { status: 502 });
        }

        const searchData = await searchResp.json();
        if (!searchData.results || searchData.results.length === 0) {
          return Response.json({ error: 'Movie not found on TMDB' }, { status: 404 });
        }

        const tmdbMovie = searchData.results[0];
        const tmdbId = tmdbMovie.id;

        // Fetch full details from TMDB
        const detailsResp = await fetch(
          `https://api.tmdb.org/3/movie/${tmdbId}`,
          { headers: { 'Authorization': `Bearer ${TMDB_TOKEN}` } }
        );
        const details = await detailsResp.json();

        // Fetch credits (cast & crew)
        const creditsResp = await fetch(
          `https://api.tmdb.org/3/movie/${tmdbId}/credits`,
          { headers: { 'Authorization': `Bearer ${TMDB_TOKEN}` } }
        );
        const credits = await creditsResp.json();

        // Prepare cast data with avatars
        const castList = (credits.cast || []).slice(0, 8).map(c => ({
          name: c.name,
          profile_path: c.profile_path
        }));
        const castNames = castList.map(c => c.name).join(', ');

        // Director
        const directors = (credits.crew || []).filter(c => c.job === 'Director').map(c => c.name);
        const director = directors.join(', ');

        // Genres
        const genres = (details.genres || []).map(g => g.name).join(' / ');

        // Poster
        const poster = details.poster_path 
          ? `https://image.tmdb.org/t/p/original${details.poster_path}` 
          : '';

        // Ratings
        const tmdbRating = details.vote_average ? String(Math.round(details.vote_average * 10) / 10) : '';
        const imdbId = details.imdb_id || '';

        // Year
        const year = details.release_date ? details.release_date.substring(0, 4) : '';

        // Intro
        const intro = details.overview || '';

        // Insert into database
        await env.DB.prepare(`
          INSERT INTO movies (id, douban_id, douban_url, title, title_cn, year, type, rating, tmdb_rating, imdb_id, genre, director, cast, cast_data, intro, poster, tmdb_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          doubanId,
          doubanId,
          doubanUrl,
          details.original_title || details.title || '',
          details.title || '',
          year,
          details.number_of_seasons ? 'tv' : 'movie',
          '', // douban rating (empty since we use TMDB)
          tmdbRating,
          imdbId,
          genres,
          director,
          castNames,
          JSON.stringify(castList),
          intro,
          poster,
          String(tmdbId)
        ).run();

        const movie = await env.DB.prepare('SELECT * FROM movies WHERE id = ?').bind(doubanId).first();
        return Response.json({ movie, status: 'created' }, { headers: corsHeaders });
      }

      // Route: GET /api/movies/:id
      if (path.match(/^\/api\/movies\/([^/]+)$/) && request.method === 'GET') {
        const id = path.match(/^\/api\/movies\/([^/]+)$/)[1];
        const movie = await env.DB.prepare('SELECT * FROM movies WHERE id = ?').bind(id).first();
        
        if (!movie) {
          return Response.json({ error: 'Movie not found' }, { status: 404 });
        }

        const { results: resources } = await env.DB.prepare(
          'SELECT * FROM resources WHERE movie_id = ? ORDER BY added_at DESC'
        ).bind(id).all();

        return Response.json({ movie: { ...movie, resources } }, { headers: corsHeaders });
      }

      // Route: DELETE /api/movies/:id
      if (path.match(/^\/api\/movies\/([^/]+)$/) && request.method === 'DELETE') {
        const id = path.match(/^\/api\/movies\/([^/]+)$/)[1];
        await env.DB.prepare('DELETE FROM movies WHERE id = ?').bind(id).run();
        return Response.json({ status: 'deleted' }, { headers: corsHeaders });
      }

      // Route: POST /api/movies/:id/resources - Search and add resources
      if (path.match(/^\/api\/movies\/([^/]+)\/resources$/) && request.method === 'POST') {
        const movieId = path.match(/^\/api\/movies\/([^/]+)\/resources$/)[1];
        const movie = await env.DB.prepare('SELECT * FROM movies WHERE id = ?').bind(movieId).first();
        
        if (!movie) {
          return Response.json({ error: 'Movie not found' }, { status: 404 });
        }

        // Search 91panta for resources
        const searchQuery = encodeURIComponent(movie.title_cn || movie.title);
        const searchUrl = `${PANTALIST_URL}?keyword=${searchQuery}`;
        
        const searchResp = await fetch(searchUrl, {
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          }
        });

        const html = await searchResp.text();
        
        // Parse 139 cloud links from HTML
        const linkRegex = /(https?:\/\/(?:yun|caiyun)\.139\.com\/[^\s<"']+)/g;
        const links = [...new Set(html.match(linkRegex) || [])];

        // Verify and add links
        const added = [];
        for (const link of links) {
          const existing = await env.DB.prepare(
            'SELECT * FROM resources WHERE movie_id = ? AND url = ?'
          ).bind(movieId, link).first();

          if (!existing) {
            await env.DB.prepare(`
              INSERT INTO resources (movie_id, url, source, verified)
              VALUES (?, ?, '91panta', 1)
            `).bind(movieId, link).run();
            added.push(link);
          }
        }

        return Response.json({ 
          movie: movie,
          resources_found: links.length,
          resources_added: added.length,
          links: links 
        }, { headers: corsHeaders });
      }

      // Route: DELETE /api/resources/:id - Delete a resource
      if (path.match(/^\/api\/resources\/([^/]+)$/) && request.method === 'DELETE') {
        const resourceId = path.match(/^\/api\/resources\/([^/]+)$/)[1];
        await env.DB.prepare('DELETE FROM resources WHERE id = ?').bind(resourceId).run();
        return Response.json({ status: 'deleted' }, { headers: corsHeaders });
      }

      // Health check
      if (path === '/api/health') {
        return Response.json({ status: 'ok' }, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error('Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }
};
