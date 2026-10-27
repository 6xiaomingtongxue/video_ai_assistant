# Third-party notices

VideoLens Bridge embeds portions of CLIProxyAPI through its public Go SDK.
CLIProxyAPI is distributed under the MIT License. The required license text is
included in `third_party/CLIProxyAPI-LICENSE.txt`.

The embedded SDK supplies provider authentication, token refresh, request
translation, and local OpenAI-compatible routing. VideoLens Bridge supplies the
Native Messaging lifecycle, per-install configuration, and single-account
credential cleanup.

For automatic video text processing, the first use downloads uv (MIT or Apache
2.0), an isolated Python distribution managed by uv, Node.js (MIT and bundled
dependency notices), yt-dlp (Unlicense with dependency licenses), and
faster-whisper (MIT with dependency licenses). These are installed under the
VideoLens data directory. uv and Node.js release archives are verified against
their official SHA-256 checksums. Python and Node.js distributions retain their
bundled license files. Speech models retain their upstream licensing terms.
