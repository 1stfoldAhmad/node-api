const express = require('express');
const router = express.Router();
const { fetchPlaylistVideos } = require('../services/youtubePlaylist');

/**
 * GET /api/playlist/:playlistId
 * Fetches all videos from a YouTube playlist with their transcripts
 * Query params: lang (optional, default: 'en')
 */
router.get('/:playlistId', async (req, res, next) => {
  try {
    const { playlistId } = req.params;
    const lang = req.query.lang || 'en';

    if (!playlistId) {
      return res.status(400).json({ error: 'Playlist ID is required' });
    }

    console.log(`Fetching playlist ${playlistId} with transcripts in language: ${lang}`);
    
    const playlistData = await fetchPlaylistVideos(playlistId, lang);

    res.json(playlistData);
  } catch (error) {
    console.error('Playlist fetch error:', error.message);
    next(error);
  }
});

module.exports = router;

