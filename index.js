require('dotenv').config();
const express = require('express');
const cors = require('cors');
const transcriptRouter = require('./routes/transcript');
const playlistRouter = require('./routes/playlist');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/transcript', transcriptRouter);
app.use('/api/playlist', playlistRouter);

// Default home page
app.get('/', (req, res) => {
  res.json({
    message: 'YouTube Transcription API',
    docs: {
      transcript: 'GET /api/transcript?videoId=VIDEO_ID',
      playlist: 'GET /api/playlist?playlistId=PLAYLIST_ID',
    },
    status: 'running',
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

