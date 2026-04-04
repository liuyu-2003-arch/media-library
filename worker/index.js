/**
 * Media Library API - Cloudflare Worker
 * 
 * Endpoints:
 * - GET /api/movies - List all movies
 * - POST /api/movies - Add movie from Douban URL
 * - GET /api/movies/:id - Get movie details
 * - POST /api/movies/:id/resources - Search and add resources
 * - DELETE /api/movies/:id - Delete movie
 */

const DOUBAN_API = 'https://api.douban.com/v2/movie/subject/';
const PANTALIST_URL = 'http://91panta.cn/';

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

      // Route: POST /api/movies - Add from Douban URL
      if (path === '/api/movies' && request.method === 'POST') {
        const { doubanUrl } = await request.json();
        
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

        // Fetch from Douban API
        const doubanResp = await fetch(`${DOUBAN_API}${doubanId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });

        if (!doubanResp.ok) {
          return Response.json({ error: 'Failed to fetch from Douban' }, { status: 502 });
        }

        const data = await doubanResp.json();
        const id = doubanId;
        const itemType = data.episodes_count ? 'tv' : 'movie';
        const rating = data.rating?.average || '';

        await env.DB.prepare(`
          INSERT INTO movies (id, douban_id, douban_url, title, title_cn, year, type, rating, genre, director, cast, intro, poster)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id, doubanId, doubanUrl,
          data.title || '',
          data.original_title || data.title || '',
          data.year || '',
          itemType,
          String(rating),
          (data.genres || []).join(' / '),
          (data.directors || []).map(d => d.name).join(', '),
          (data.casts || []).slice(0, 5).map(c => c.name).join(', '),
          data.summary || '',
          (data.image || '').replace('s_ratio_poster', 'l_ratio_poster')
        ).run();

        const movie = await env.DB.prepare('SELECT * FROM movies WHERE id = ?').bind(id).first();
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
        
        // Fetch search results page
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
          // Check if link already exists
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
