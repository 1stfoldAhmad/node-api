const { fetchTranscript: fetchTranscriptFromLibrary } = require('youtube-transcript-plus');

/**
 * Fetches transcript for a YouTube video
 * @param {string} videoId - YouTube video ID
 * @param {string} lang - Language code (e.g., 'en', 'es', 'fr')
 * @returns {Promise<Array>} Array of transcript items with text, start, and duration
 */
async function fetchTranscript(videoId, lang = 'en') {
  try {
    // youtube-transcript-plus returns offset and duration in seconds
    // It accepts lang as a second parameter or in options
    const transcriptItems = await fetchTranscriptFromLibrary(videoId, { lang: lang });

    // Check if we got an empty array
    if (!transcriptItems || transcriptItems.length === 0) {
      // Try without language specification to see if any transcript exists
      try {
        const anyLangTranscript = await fetchTranscriptFromLibrary(videoId);
        if (anyLangTranscript && anyLangTranscript.length > 0) {
          throw new Error(`Transcript not available in language '${lang}'. The video has transcripts in other languages.`);
        }
      } catch (fallbackError) {
        // If fallback also fails, throw the original empty array error
        if (fallbackError.message.includes('not available in language')) {
          throw fallbackError;
        }
      }
      throw new Error('Transcript is empty or not available for this video. The video may not have captions/subtitles enabled.');
    }

    // Transform the transcript to match the expected format
    // Note: offset and duration are already in seconds from the library
    // Also decode HTML entities in text
    return transcriptItems.map((item) => ({
      text: decodeHtmlEntities(item.text),
      start: item.offset, // Already in seconds
      duration: item.duration, // Already in seconds
    }));
  } catch (error) {
    // Handle specific error cases
    const errorMessage = error.message || '';
    
    if (errorMessage.includes('Transcript is disabled') || 
        errorMessage.includes('not available for this video')) {
      throw new Error('Transcript is not available for this video');
    }
    if (errorMessage.includes('not available in language')) {
      throw error; // Re-throw language-specific errors as-is
    }
    if (errorMessage.includes('Video is unavailable') ||
        errorMessage.includes('does not exist')) {
      throw new Error('Video is unavailable or does not exist');
    }
    if (errorMessage.includes('Too many requests')) {
      throw new Error('Too many requests. Please try again later');
    }
    
    // Re-throw if it's already our custom error
    if (errorMessage.includes('Transcript is empty') || 
        errorMessage.includes('not available for this video')) {
      throw error;
    }
    
    throw new Error(`Failed to fetch transcript: ${error.message}`);
  }
}

/**
 * Decode HTML entities in text
 * @param {string} text - Text with HTML entities
 * @returns {string} Decoded text
 */
function decodeHtmlEntities(text) {
  if (!text) return text;
  
  // Decode numeric entities like &#39; or &#x27;
  text = text.replace(/&#(\d+);/g, (match, dec) => {
    return String.fromCharCode(parseInt(dec, 10));
  });
  
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  
  // Decode named entities (must be done after numeric to avoid double-decoding)
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
  };
  
  // Replace named entities (iterate to handle nested entities like &amp;gt;
  let previousText = '';
  while (text !== previousText) {
    previousText = text;
    for (const [entity, decoded] of Object.entries(entities)) {
      text = text.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), decoded);
    }
  }
  
  return text;
}

module.exports = {
  fetchTranscript,
};

