const express = require('express');
const { 
  fetchTranscript, 
  getCacheStats, 
  clearCache,
  TranscriptError,
  VideoNotFoundError,
  TranscriptNotAvailableError,
  RateLimitError,
  NetworkError
} = require('../services/youtubeTranscript');

const router = express.Router();

// Rate limiting store (in production, use Redis or similar)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute per IP

/**
 * Simple rate limiting middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
function rateLimit(req, res, next) {
  const clientId = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitStore.has(clientId)) {
    rateLimitStore.set(clientId, { requests: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const clientData = rateLimitStore.get(clientId);
  
  // Reset if window has passed
  if (now > clientData.resetTime) {
    rateLimitStore.set(clientId, { requests: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  // Check if limit exceeded
  if (clientData.requests >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
      }
    });
  }
  
  // Increment request count
  clientData.requests++;
  next();
}

/**
 * Validates and extracts video ID from various YouTube URL formats
 * @param {string} input - Video ID or YouTube URL
 * @returns {string|null} Extracted video ID or null if invalid
 */
function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  
  // If it's already a video ID (11 characters, alphanumeric with _ and -)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }
  
  // Extract from various YouTube URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
  ];
  
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * GET /api/transcript/:videoId
 * Fetches transcript for a YouTube video
 */
router.get('/:videoId', rateLimit, async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Extract and validate video ID
    const videoId = extractVideoId(req.params.videoId);
    if (!videoId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_VIDEO_ID',
          message: 'Invalid YouTube video ID or URL format'
        }
      });
    }
    
    // Validate language parameter
    const language = req.query.lang || req.query.language || 'en';
    if (language && !/^[a-z]{2}(-[A-Z]{2})?$/.test(language)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LANGUAGE',
          message: 'Invalid language code. Use ISO 639-1 format (e.g., "en", "es", "en-US")'
        }
      });
    }
    
    // Parse additional options
    const options = {
      useCache: req.query.cache !== 'false', // Default to true unless explicitly disabled
      retryOnError: req.query.retry !== 'false', // Default to true unless explicitly disabled
    };
    
    // Fetch transcript
    const result = await fetchTranscript(videoId, language, options);
    
    // Calculate response time
    const responseTime = Date.now() - startTime;
    
    res.json({
      success: true,
      data: result,
      meta: {
        responseTime: `${responseTime}ms`,
        requestId: req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      }
    });
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    // Log error for monitoring (in production, use proper logging service)
    console.error('Transcript fetch error:', {
      videoId: req.params.videoId,
      language: req.query.lang,
      error: error.message,
      stack: error.stack,
      responseTime
    });
    
    // Handle specific error types
    if (error instanceof VideoNotFoundError) {
      return res.status(404).json({
        success: false,
        error: {
          code: error.code,
          message: error.message
        },
        meta: {
          responseTime: `${responseTime}ms`
        }
      });
    }
    
    if (error instanceof TranscriptNotAvailableError) {
      return res.status(404).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          suggestion: 'Try a different language or check if the video has captions enabled'
        },
        meta: {
          responseTime: `${responseTime}ms`
        }
      });
    }
    
    if (error instanceof RateLimitError) {
      return res.status(429).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          retryAfter: 60 // Suggest waiting 1 minute
        },
        meta: {
          responseTime: `${responseTime}ms`
        }
      });
    }
    
    if (error instanceof NetworkError) {
      return res.status(503).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: true
        },
        meta: {
          responseTime: `${responseTime}ms`
        }
      });
    }
    
    if (error instanceof TranscriptError) {
      const statusCode = error.retryable ? 503 : 400;
      return res.status(statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable
        },
        meta: {
          responseTime: `${responseTime}ms`
        }
      });
    }
    
    // Generic error fallback
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while fetching the transcript'
      },
      meta: {
        responseTime: `${responseTime}ms`
      }
    });
  }
});

/**
 * POST /api/transcript/batch
 * Fetches transcripts for multiple videos (limited batch size for performance)
 */
router.post('/batch', rateLimit, async (req, res) => {
  const startTime = Date.now();
  const MAX_BATCH_SIZE = 5; // Limit batch size to prevent abuse
  
  try {
    const { videoIds, language = 'en', options = {} } = req.body;
    
    if (!Array.isArray(videoIds)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'videoIds must be an array'
        }
      });
    }
    
    if (videoIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'EMPTY_BATCH',
          message: 'At least one video ID is required'
        }
      });
    }
    
    if (videoIds.length > MAX_BATCH_SIZE) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'BATCH_TOO_LARGE',
          message: `Maximum batch size is ${MAX_BATCH_SIZE} videos`
        }
      });
    }
    
    // Process videos in parallel with error handling
    const results = await Promise.allSettled(
      videoIds.map(async (videoId) => {
        const extractedId = extractVideoId(videoId);
        if (!extractedId) {
          throw new TranscriptError(`Invalid video ID: ${videoId}`, 'INVALID_VIDEO_ID');
        }
        
        const result = await fetchTranscript(extractedId, language, options);
        return { videoId: extractedId, ...result };
      })
    );
    
    // Separate successful and failed results
    const successful = [];
    const failed = [];
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successful.push(result.value);
      } else {
        failed.push({
          videoId: videoIds[index],
          error: {
            code: result.reason.code || 'UNKNOWN_ERROR',
            message: result.reason.message || 'Unknown error occurred'
          }
        });
      }
    });
    
    const responseTime = Date.now() - startTime;
    
    res.json({
      success: true,
      data: {
        successful,
        failed,
        summary: {
          total: videoIds.length,
          successful: successful.length,
          failed: failed.length
        }
      },
      meta: {
        responseTime: `${responseTime}ms`
      }
    });
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    console.error('Batch transcript error:', {
      error: error.message,
      stack: error.stack,
      responseTime
    });
    
    res.status(500).json({
      success: false,
      error: {
        code: 'BATCH_PROCESSING_ERROR',
        message: 'An error occurred while processing the batch request'
      },
      meta: {
        responseTime: `${responseTime}ms`
      }
    });
  }
});

/**
 * GET /api/transcript/cache/stats
 * Returns cache statistics (for monitoring/debugging)
 */
router.get('/cache/stats', (req, res) => {
  try {
    const stats = getCacheStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'CACHE_STATS_ERROR',
        message: 'Failed to retrieve cache statistics'
      }
    });
  }
});

/**
 * DELETE /api/transcript/cache
 * Clears the transcript cache (admin endpoint)
 */
router.delete('/cache', (req, res) => {
  try {
    const pattern = req.query.pattern;
    clearCache(pattern);
    
    res.json({
      success: true,
      message: pattern ? `Cache cleared for pattern: ${pattern}` : 'Cache cleared successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'CACHE_CLEAR_ERROR',
        message: 'Failed to clear cache'
      }
    });
  }
});

/**
 * GET /api/transcript/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage()
    }
  });
});

module.exports = router;