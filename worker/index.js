/**
 * Media Library API - Cloudflare Worker
 * 
 * Endpoints:
 * - GET /api/movies - List all movies
 * - POST /api/movies - Add movie from Douban URL (fetches data from TMDB)
 * - GET /api/movies/:id - Get movie details
 * - POST /api/movies/:id/refresh - Refresh movie data from Douban (Chinese content)
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

    // Convert snake_case DB keys to camelCase
    const toCamelCase = (obj) => {
      if (Array.isArray(obj)) return obj.map(toCamelCase);
      if (obj === null || typeof obj !== 'object') return obj;
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [
          k.replace(/_([a-z])/g, (_, l) => l.toUpperCase()),
          v && typeof v === 'object' ? toCamelCase(v) : v
        ])
      );
    };

    try {
      // Route: GET /api/movies
      if (path === '/api/movies' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM movies ORDER BY added_at DESC'
        ).all();
        return Response.json({ movies: toCamelCase(results) }, { headers: corsHeaders });
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
        return Response.json({ movie: toCamelCase(movie), status: 'created' }, { headers: corsHeaders });
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

        return Response.json({ movie: toCamelCase({ ...movie, resources }) }, { headers: corsHeaders });
      }

      // Route: DELETE /api/movies/:id
      if (path.match(/^\/api\/movies\/([^/]+)$/) && request.method === 'DELETE') {
        const id = path.match(/^\/api\/movies\/([^/]+)$/)[1];
        await env.DB.prepare('DELETE FROM movies WHERE id = ?').bind(id).run();
        return Response.json({ status: 'deleted' }, { headers: corsHeaders });
      }

      // Route: POST /api/movies/:id/refresh - Refresh from Douban for Chinese content
      if (path.match(/^\/api\/movies\/([^/]+)\/refresh$/) && request.method === 'POST') {
        const id = path.match(/^\/api\/movies\/([^/]+)\/refresh$/)[1];
        const movie = await env.DB.prepare('SELECT * FROM movies WHERE id = ?').bind(id).first();
        
        if (!movie) {
          return Response.json({ error: 'Movie not found' }, { status: 404 });
        }

        // Fetch from Douban API
        const doubanApiUrl = `https://api.douban.com/v2/movie/subject/${id}`;
        const doubanResp = await fetch(doubanApiUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!doubanResp.ok) {
          return Response.json({ error: 'Failed to fetch from Douban' }, { status: 502 });
        }

        const doubanData = await doubanResp.json();

        // Update movie with Chinese content
        const titleCN = doubanData.title || movie.title_cn || movie.title;
        const intro = doubanData.summary || movie.intro || '';

        await env.DB.prepare(`
          UPDATE movies SET title_cn = ?, intro = ? WHERE id = ?
        `).bind(titleCN, intro, id).run();

        const updated = await env.DB.prepare('SELECT * FROM movies WHERE id = ?').bind(id).first();
        return Response.json({ movie: toCamelCase(updated), status: 'refreshed' }, { headers: corsHeaders });
      }

      if (path.match(/^\/api\/movies\/([^/]+)\/resources$/) && request.method === 'POST') {
        const movieId = path.match(/^\/api\/movies\/([^/]+)\/resources$/)[1];
        const movie = await env.DB.prepare('SELECT * FROM movies WHERE id = ?').bind(movieId).first();

        if (!movie) {
          return Response.json({ error: 'Movie not found' }, { status: 404 });
        }

        const searchTitles = [
          movie.title_cn || movie.title,
          movie.title,
          movie.original_title || ''
        ].filter(t => t && t !== (movie.title_cn || movie.title)).slice(0, 3);

        const seenLinks = new Set();
        const { results: existingResources } = await env.DB.prepare(
          'SELECT url FROM resources WHERE movie_id = ?'
        ).bind(movieId).all();
        existingResources.forEach(r => seenLinks.add(r.url));

        const allFoundLinks = [];
        const sources = [];

        async function fetchWithTimeout(url, options = {}, timeout = 8000) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);
          try {
            const resp = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            return resp;
          } catch (e) {
            clearTimeout(timeoutId);
            return null;
          }
        }

        async function validateLink(url) {
          try {
            if (url.includes('139.com')) {
              const resp = await fetchWithTimeout(url, {
                method: 'GET',
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
                redirect: 'follow'
              }, 8000);
              if (!resp || !resp.ok) return false;
              const html = await resp.text();
              const expiredPatterns = [
                '分享已被取消',
                '分享已过期',
                '链接不存在',
                '该文件已被删除',
                '已过期',
                '已被取消',
                '无法查看',
                'error',
                '404'
              ];
              const lowerHtml = html.toLowerCase();
              for (const pattern of expiredPatterns) {
                if (lowerHtml.includes(pattern.toLowerCase())) return false;
              }
              if (html.includes('shareweb') || html.includes('fileId') || html.includes('fileName')) return true;
              return html.length > 5000;
            }
            const resp = await fetchWithTimeout(url, {
              method: 'HEAD',
              headers: { 'User-Agent': 'Mozilla/5.0' },
              redirect: 'follow'
            }, 5000);
            if (resp) {
              return resp.ok || resp.status === 403;
            }
            return false;
          } catch {
            return false;
          }
        }

        function extractLinks(html) {
          const linkRegex139 = /(https?:\/\/(?:yun|caiyun)\.139\.com\/[\w\-\.~:\/@#!$&'()*+,;=%?]+)/g;
          const linkRegexAli = /(https?:\/\/(?:www\.)?(?:aliyundrive\.com|alipan\.com)\/s\/[\w\-]+)/g;
          let links139 = (html.match(linkRegex139) || []).filter(l => !l.endsWith('..') && l.length < 500);
          links139 = links139.map(l => l.endsWith('.') ? l.replace(/\.*$/, '') : l);
          const linksAli = (html.match(linkRegexAli) || []).filter(l => l.length < 200);
          return [...links139, ...linksAli];
        }

        for (const query of searchTitles) {
          const searchUrl = `${PANTALIST_URL}?keyword=${encodeURIComponent(query)}`;

          try {
            const searchResp = await fetchWithTimeout(searchUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              }
            });

            if (searchResp && searchResp.ok) {
              const html = await searchResp.text();
              const links = extractLinks(html);

              for (const link of links) {
                if (!seenLinks.has(link)) {
                  seenLinks.add(link);
                  const isValid = await validateLink(link);
                  if (isValid) {
                    const source = link.includes('139.com') ? '91panta_139' : '91panta_ali';
                    allFoundLinks.push({ url: link, source, query, valid: true });
                  }
                }
              }

              if (links.length > 0 && !sources.includes('91panta')) {
                sources.push('91panta');
              }
            }
          } catch (e) {
            console.error(`91panta search failed for "${query}":`, e.message);
          }

          await new Promise(r => setTimeout(r, 500));
        }

        const mainTitle = movie.title_cn || movie.title;

        const googleSearches = [
          { url: `https://www.google.com/search?q=site:yun.139.com+${encodeURIComponent(mainTitle)}`, source: 'google_139' },
          { url: `https://www.google.com/search?q=site:aliyundrive.com+${encodeURIComponent(mainTitle)}`, source: 'google_ali' }
        ];

        for (const gs of googleSearches) {
          try {
            const googleResp = await fetchWithTimeout(gs.url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
              }
            });

            if (googleResp && googleResp.ok) {
              const html = await googleResp.text();
              const links = extractLinks(html);

              for (const link of links) {
                if (!seenLinks.has(link)) {
                  seenLinks.add(link);
                  const isValid = await validateLink(link);
                  if (isValid) {
                    allFoundLinks.push({ url: link, source: gs.source, query: mainTitle, valid: true });
                  }
                }
              }

              if (links.length > 0 && !sources.includes(gs.source)) {
                sources.push(gs.source);
              }
            }
          } catch (e) {
            console.error(`${gs.source} search failed:`, e.message);
          }
        }

        const added = [];
        for (const item of allFoundLinks) {
          await env.DB.prepare(`
            INSERT INTO resources (movie_id, url, source, verified, status, last_checked)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
          `).bind(movieId, item.url, item.source, item.valid ? 1 : 0, item.valid ? 'valid' : 'expired').run();
          added.push({ url: item.url, valid: item.valid });
        }

        return Response.json({
          movie: movie,
          sources_searched: sources,
          resources_found: allFoundLinks.length,
          resources_added: added.length,
          valid_resources: added.filter(a => a.valid).length,
          links: added
        }, { headers: corsHeaders });
      }

      if (path.match(/^\/api\/movies\/([^/]+)\/resources\/validate$/) && request.method === 'POST') {
        const movieId = path.match(/^\/api\/movies\/([^/]+)\/resources\/validate$/)[1];

        const { results: resources } = await env.DB.prepare(
          'SELECT * FROM resources WHERE movie_id = ?'
        ).bind(movieId).all();

        async function validateExistingLink(url) {
          try {
            if (url.includes('139.com')) {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 8000);
              const resp = await fetch(url, {
                method: 'GET',
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
                redirect: 'follow',
                signal: controller.signal
              });
              clearTimeout(timeoutId);
              if (!resp || !resp.ok) return false;
              const html = await resp.text();
              const expiredPatterns = ['分享已被取消', '分享已过期', '链接不存在', '该文件已被删除', '已过期', '已被取消', '无法查看'];
              const lowerHtml = html.toLowerCase();
              for (const pattern of expiredPatterns) {
                if (lowerHtml.includes(pattern.toLowerCase())) return false;
              }
              return html.length > 5000;
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(url, {
              method: 'HEAD',
              headers: { 'User-Agent': 'Mozilla/5.0' },
              redirect: 'follow',
              signal: controller.signal
            });
            clearTimeout(timeoutId);
            return resp.ok || resp.status === 403;
          } catch {
            return false;
          }
        }

        const results = [];
        for (const resource of resources) {
          const isValid = await validateExistingLink(resource.url);
          const status = isValid ? 'valid' : 'expired';
          await env.DB.prepare(
            'UPDATE resources SET status = ?, last_checked = datetime(\'now\') WHERE id = ?'
          ).bind(status, resource.id).run();
          results.push({ id: resource.id, url: resource.url, status });
          await new Promise(r => setTimeout(r, 300));
        }

        return Response.json({
          validated: results.length,
          valid: results.filter(r => r.status === 'valid').length,
          expired: results.filter(r => r.status === 'expired').length,
          results
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

      if (path === '/api/migrate' && request.method === 'POST') {
        try {
          await env.DB.prepare(`ALTER TABLE resources ADD COLUMN status TEXT DEFAULT 'unknown'`).run();
        } catch (e) { if (!e.message.includes('duplicate column')) throw e; }
        try {
          await env.DB.prepare(`ALTER TABLE resources ADD COLUMN last_checked TEXT`).run();
        } catch (e) { if (!e.message.includes('duplicate column')) throw e; }
        return Response.json({ status: 'migrated' }, { headers: corsHeaders });
      }

      if (path.match(/^\/api\/movies\/([^/]+)\/resources\/expired$/) && request.method === 'DELETE') {
        const movieId = path.match(/^\/api\/movies\/([^/]+)\/resources\/expired$/)[1];
        const result = await env.DB.prepare(
          `DELETE FROM resources WHERE movie_id = ? AND status = 'expired'`
        ).bind(movieId).run();
        return Response.json({ deleted: result.changes }, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error('Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }
};
