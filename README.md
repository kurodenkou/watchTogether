# WatchTogether

A browser-based collaborative video watching app. Stream any HLS video in sync with others while seeing and hearing everyone in the room via webcam and microphone.

## Features

- **Synchronized HLS playback** — play, pause, and seek stay in sync across all viewers
- **WebRTC webcam & mic** — see and hear everyone in the room, peer-to-peer
- **Room-based sessions** — create or join rooms by ID; share a link to invite others
- **Camera/mic toggles** — mute your audio or disable your video at any time
- **No accounts required** — just enter a name and room ID to join

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## Usage

1. Enter your name and a room ID (or click **↺** to generate one)
2. Click **Join Room** — allow camera and microphone access when prompted
3. Paste an HLS stream URL (`.m3u8`) into the URL bar and click **Load**
4. Share the room link with others so they can join and watch in sync

> **Tip:** The shareable link is automatically built for you — click the **⎘** button next to the room ID in the header to copy it.

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express, Socket.io |
| Video playback | [hls.js](https://github.com/video-dev/hls.js) (native HLS fallback for Safari) |
| Webcam/mic | WebRTC (mesh topology) |
| Sync signaling | Socket.io events |

## Project Structure

```
watchTogether/
├── server.js          # Express + Socket.io server (signaling & video sync relay)
├── package.json
└── public/
    ├── index.html     # App shell
    ├── style.css      # Dark-themed responsive UI
    └── app.js         # HLS player, WebRTC connections, video sync logic
```

## How Sync Works

- **Play / Pause / Seek** events are broadcast to the room via Socket.io
- Peers apply the event locally; a >1 second drift threshold prevents unnecessary seeks
- A "Syncing…" indicator appears briefly when a remote sync event is applied
- The server stores the current video state so late joiners start at the right position

## Requirements

- Node.js 18+
- A modern browser (Chrome, Firefox, Edge, Safari 14+)
- HTTPS or `localhost` — required by browsers for camera/mic access
