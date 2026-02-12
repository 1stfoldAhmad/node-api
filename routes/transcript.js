const express = require('express');
const router = express.Router();
const { fetchTranscript } = require('../services/youtubeTranscript');

/**
 * GET /api/transcript/:videoId
 * Fetches transcript for a YouTube video
 * Query params: lang (optional, default: 'en')
 */
router.get('/:videoId', async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const lang = req.query.lang || 'en';

    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    console.log(`Fetching transcript for video: ${videoId}, language: ${lang}`);
    
    const transcript = await fetchTranscript(videoId, lang);

    if (!transcript || transcript.length === 0) {
      return res.status(404).json({ 
        error: 'Transcript not found or empty',
        videoId: videoId 
      });
    }

    res.json({
      videoId: videoId,
      transcript: transcript,
    });
  } catch (error) {
    console.error('Transcript fetch error:', error.message);
    next(error);
  }
});

module.exports = router;

