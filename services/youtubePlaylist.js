const axios = require('axios');
const { fetchTranscript } = require('./youtubeTranscript');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3';

/**
 * Fetches all videos from a YouTube playlist with their transcripts
 * @param {string} playlistId - YouTube playlist ID
 * @param {string} lang - Language code for transcripts (e.g., 'en', 'es', 'fr')
 * @returns {Promise<Object>} Object containing playlistId, total count, and videos array with transcripts
 */
async function fetchPlaylistVideos(playlistId, lang = 'en') {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is not set in environment variables');
  }

  try {
    let allVideos = [];
    let nextPageToken = null;
    let totalResults = 0;

    do {
      const response = await axios.get(`${YOUTUBE_API_BASE_URL}/playlistItems`, {
        params: {
          part: 'snippet,contentDetails',
          playlistId: playlistId,
          maxResults: 50, // Maximum allowed by API
          pageToken: nextPageToken,
          key: YOUTUBE_API_KEY,
        },
      });

      const items = response.data.items || [];
      totalResults = response.data.pageInfo?.totalResults || 0;

      // Extract video information
      const videos = items
        .filter((item) => item.snippet && item.contentDetails)
        .map((item) => ({
          videoId: item.contentDetails.videoId,
          title: item.snippet.title,
          thumbnail: item.snippet.thumbnails?.medium?.url || 
                     item.snippet.thumbnails?.default?.url || 
                     `https://i.ytimg.com/vi/${item.contentDetails.videoId}/mqdefault.jpg`,
        }));

      allVideos = allVideos.concat(videos);
      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    // Fetch transcripts for all videos
    const videosWithTranscripts = await Promise.all(
      allVideos.map(async (video) => {
        try {
          const transcript = await fetchTranscript(video.videoId, lang);
          return {
            videoId: video.videoId,
            title: video.title,
            thumbnail: video.thumbnail,
            transcript: transcript,
          };
        } catch (error) {
          // If transcript fails, still include the video but with error info
          return {
            videoId: video.videoId,
            title: video.title,
            thumbnail: video.thumbnail,
            transcript: [],
            transcriptError: error.message,
          };
        }
      })
    );

    return {
      playlistId: playlistId,
      total: totalResults,
      videos: videosWithTranscripts,
    };
  } catch (error) {
    if (error.response) {
      // API error response
      if (error.response.status === 404) {
        throw new Error('Playlist not found');
      }
      if (error.response.status === 403) {
        throw new Error('API key is invalid or quota exceeded');
      }
      throw new Error(
        `YouTube API error: ${error.response.data?.error?.message || error.message}`
      );
    }
    throw new Error(`Failed to fetch playlist: ${error.message}`);
  }
}

module.exports = {
  fetchPlaylistVideos,
};

