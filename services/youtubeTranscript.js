const NodeCache = require('node-cache');
const { promisify } = require('util');

// Multiple library imports for fallback support
let primaryLibrary, fallbackLibrary1, fallbackLibrary2;

try {
  // Primary: youtube-transcript (most reliable according to web search)
  primaryLibrary = require('youtube-transcript');
} catch (e) {
  console.warn('Primary transcript library not available');
}

try {
  // Fallback 1: Keep current library as fallback
  fallbackLibrary1 = require('youtube-transcript-plus');
} catch (e) {
  console.warn('Fallback library 1 not available');
}

try {
  // Fallback 2: Alternative library
  fallbackLibrary2 = require('ai-youtube-transcript');
} catch (e) {
  console.warn('Fallback library 2 not available');
}

// Cache configuration - 1 hour TTL, check every 10 minutes
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Custom error classes for better error handling
class TranscriptError extends Error {
  constructor(message, code, retryable = false) {
    super(message);
    this.name = 'TranscriptError';
    this.code = code;
    this.retryable = retryable;
  }
}

class VideoNotFoundError extends TranscriptError {
  constructor(videoId) {
    super(`Video '${videoId}' not found or unavailable`, 'VIDEO_NOT_FOUND', false);
  }
}

class TranscriptNotAvailableError extends TranscriptError {
  constructor(videoId, language) {
    const msg = language 
      ? `Transcript not available for video '${videoId}' in language '${language}'`
      : `Transcript not available for video '${videoId}'`;
    super(msg, 'TRANSCRIPT_NOT_AVAILABLE', false);
  }
}

class RateLimitError extends TranscriptError {
  constructor() {
    super('Rate limit exceeded. Please try again later', 'RATE_LIMIT', true);
  }
}

class NetworkError extends TranscriptError {
  constructor(message) {
    super(`Network error: ${message}`, 'NETWORK_ERROR', true);
  }
}

/**
 * Validates YouTube video ID format
 * @param {string} videoId - YouTube video ID
 * @returns {boolean} True if valid format
 */
function isValidVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return false;
  
  // YouTube video ID patterns
  const patterns = [
    /^[a-zA-Z0-9_-]{11}$/, // Standard 11-character ID
    /^[a-zA-Z0-9_-]{10}$/, // Some older videos
  ];
  
  return patterns.some(pattern => pattern.test(videoId));
}

/**
 * Validates language code format
 * @param {string} lang - Language code
 * @returns {boolean} True if valid format
 */
function isValidLanguageCode(lang) {
  if (!lang) return true; // undefined/null is valid (will use default)
  if (typeof lang !== 'string') return false;
  
  // ISO 639-1 (2-letter) or extended codes like 'en-US'
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(lang);
}

/**
 * Implements exponential backoff retry logic
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {Promise} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry non-retryable errors
      if (error instanceof TranscriptError && !error.retryable) {
        throw error;
      }
      
      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }
      
      // Calculate delay with exponential backoff and jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Attempts to fetch transcript using primary library
 * @param {string} videoId - YouTube video ID
 * @param {string} lang - Language code
 * @returns {Promise<Array>} Transcript items
 */
async function fetchWithPrimaryLibrary(videoId, lang) {
  if (!primaryLibrary) {
    throw new Error('Primary library not available');
  }
  
  try {
    // Different libraries have different APIs
    const options = lang ? { lang } : {};
    const transcript = await primaryLibrary.YoutubeTranscript.fetchTranscript(videoId, options);
    
    return transcript.map(item => ({
      text: decodeHtmlEntities(item.text || ''),
      start: parseFloat(item.offset || item.start || 0),
      duration: parseFloat(item.duration || 0),
    }));
  } catch (error) {
    throw normalizeError(error, videoId, lang);
  }
}

/**
 * Attempts to fetch transcript using fallback library 1
 * @param {string} videoId - YouTube video ID
 * @param {string} lang - Language code
 * @returns {Promise<Array>} Transcript items
 */
async function fetchWithFallbackLibrary1(videoId, lang) {
  if (!fallbackLibrary1) {
    throw new Error('Fallback library 1 not available');
  }
  
  try {
    const { fetchTranscript } = fallbackLibrary1;
    const options = lang ? { lang } : {};
    const transcript = await fetchTranscript(videoId, options);
    
    return transcript.map(item => ({
      text: decodeHtmlEntities(item.text || ''),
      start: parseFloat(item.offset || item.start || 0),
      duration: parseFloat(item.duration || 0),
    }));
  } catch (error) {
    throw normalizeError(error, videoId, lang);
  }
}

/**
 * Attempts to fetch transcript using fallback library 2
 * @param {string} videoId - YouTube video ID
 * @param {string} lang - Language code
 * @returns {Promise<Array>} Transcript items
 */
async function fetchWithFallbackLibrary2(videoId, lang) {
  if (!fallbackLibrary2) {
    throw new Error('Fallback library 2 not available');
  }
  
  try {
    // This library might have different API
    const transcript = await fallbackLibrary2.getTranscript(videoId, { language: lang });
    
    return transcript.map(item => ({
      text: decodeHtmlEntities(item.text || ''),
      start: parseFloat(item.start || item.offset || 0),
      duration: parseFloat(item.duration || 0),
    }));
  } catch (error) {
    throw normalizeError(error, videoId, lang);
  }
}

/**
 * Normalizes errors from different libraries into consistent error types
 * @param {Error} error - Original error
 * @param {string} videoId - Video ID for context
 * @param {string} lang - Language for context
 * @returns {TranscriptError} Normalized error
 */
function normalizeError(error, videoId, lang) {
  const message = error.message || error.toString();
  const lowerMessage = message.toLowerCase();
  
  // Video not found errors
  if (lowerMessage.includes('video is unavailable') ||
      lowerMessage.includes('does not exist') ||
      lowerMessage.includes('not found') ||
      lowerMessage.includes('invalid video id')) {
    return new VideoNotFoundError(videoId);
  }
  
  // Transcript not available errors
  if (lowerMessage.includes('transcript is disabled') ||
      lowerMessage.includes('not available for this video') ||
      lowerMessage.includes('no transcript available') ||
      lowerMessage.includes('transcript is empty')) {
    return new TranscriptNotAvailableError(videoId, lang);
  }
  
  // Language-specific errors
  if (lowerMessage.includes('not available in language') ||
      lowerMessage.includes('language not supported')) {
    return new TranscriptNotAvailableError(videoId, lang);
  }
  
  // Rate limiting errors
  if (lowerMessage.includes('too many requests') ||
      lowerMessage.includes('rate limit') ||
      lowerMessage.includes('quota exceeded') ||
      error.status === 429) {
    return new RateLimitError();
  }
  
  // Network errors
  if (lowerMessage.includes('network') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('connection') ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNRESET') {
    return new NetworkError(message);
  }
  
  // Generic retryable server errors
  if (error.status >= 500 && error.status < 600) {
    return new TranscriptError(`Server error: ${message}`, 'SERVER_ERROR', true);
  }
  
  // Default to non-retryable error
  return new TranscriptError(message, 'UNKNOWN_ERROR', false);
}

/**
 * Fetches transcript for a YouTube video with multiple fallbacks and enhanced error handling
 * @param {string} videoId - YouTube video ID
 * @param {string} lang - Language code (e.g., 'en', 'es', 'fr')
 * @param {Object} options - Additional options
 * @param {boolean} options.useCache - Whether to use caching (default: true)
 * @param {boolean} options.retryOnError - Whether to retry on errors (default: true)
 * @returns {Promise<Object>} Transcript data with metadata
 */
async function fetchTranscript(videoId, lang = 'en', options = {}) {
  const { useCache = true, retryOnError = true } = options;
  
  // Input validation
  if (!isValidVideoId(videoId)) {
    throw new TranscriptError('Invalid YouTube video ID format', 'INVALID_VIDEO_ID', false);
  }
  
  if (!isValidLanguageCode(lang)) {
    throw new TranscriptError('Invalid language code format', 'INVALID_LANGUAGE', false);
  }
  
  const cacheKey = `transcript:${videoId}:${lang || 'default'}`;
  
  // Try cache first
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
        fetchedAt: new Date(cached.fetchedAt),
      };
    }
  }
  
  const libraries = [
    { name: 'primary', fn: fetchWithPrimaryLibrary },
    { name: 'fallback1', fn: fetchWithFallbackLibrary1 },
    { name: 'fallback2', fn: fetchWithFallbackLibrary2 },
  ];
  
  let lastError;
  let usedLibrary = null;
  
  for (const library of libraries) {
    try {
      const fetchFn = retryOnError 
        ? () => retryWithBackoff(() => library.fn(videoId, lang))
        : () => library.fn(videoId, lang);
      
      const transcriptItems = await fetchFn();
      
      if (!transcriptItems || transcriptItems.length === 0) {
        throw new TranscriptNotAvailableError(videoId, lang);
      }
      
      usedLibrary = library.name;
      
      // Prepare response data
      const responseData = {
        videoId,
        language: lang,
        transcript: transcriptItems,
        metadata: {
          totalItems: transcriptItems.length,
          totalDuration: transcriptItems.reduce((sum, item) => sum + item.duration, 0),
          library: usedLibrary,
          fetchedAt: new Date().toISOString(),
        },
        cached: false,
      };
      
      // Cache successful results
      if (useCache) {
        cache.set(cacheKey, responseData);
      }
      
      return responseData;
      
    } catch (error) {
      lastError = error;
      
      // If it's a non-retryable error, don't try other libraries
      if (error instanceof VideoNotFoundError) {
        break;
      }
      
      console.warn(`Library ${library.name} failed for video ${videoId}:`, error.message);
      continue;
    }
  }
  
  // If all libraries failed, throw the last error
  throw lastError || new TranscriptError('All transcript libraries failed', 'ALL_LIBRARIES_FAILED', false);
}

/**
 * Decode HTML entities in text with improved performance
 * @param {string} text - Text with HTML entities
 * @returns {string} Decoded text
 */
function decodeHtmlEntities(text) {
  if (!text || typeof text !== 'string') return text || '';
  
  // Use a more efficient approach with regex replacements
  const entityMap = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
  };
  
  // Replace numeric entities first
  let result = text
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  
  // Replace named entities
  for (const [entity, replacement] of Object.entries(entityMap)) {
    result = result.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacement);
  }
  
  return result;
}

/**
 * Gets cache statistics
 * @returns {Object} Cache statistics
 */
function getCacheStats() {
  return {
    keys: cache.keys().length,
    stats: cache.getStats(),
  };
}

/**
 * Clears the transcript cache
 * @param {string} pattern - Optional pattern to match keys (supports wildcards)
 */
function clearCache(pattern) {
  if (pattern) {
    const keys = cache.keys();
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    keys.forEach(key => {
      if (regex.test(key)) {
        cache.del(key);
      }
    });
  } else {
    cache.flushAll();
  }
}

module.exports = {
  fetchTranscript,
  getCacheStats,
  clearCache,
  // Export error classes for use in routes
  TranscriptError,
  VideoNotFoundError,
  TranscriptNotAvailableError,
  RateLimitError,
  NetworkError,
};