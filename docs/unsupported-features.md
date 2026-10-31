# Unsupported Features and Limitations

The following features are unsupported or intentionally out of scope. Most
are webOS platform limitations; the rest are design choices.

## Platform limitations

- **Recording:** webOS does not provide third-party apps with APIs to record
  IPTV streams or save recordings to USB storage. See
  [LG's response about USB access](https://forum.webostv.developer.lge.com/t/webos-internal-storage-and-usb/27902).
  Server-side recording through Tvheadend, Jellyfin, or a similar DVR backend
  is the recommended alternative.

- **Multiview:** webOS supports only one active media element at a time, so two
  channels cannot be played simultaneously. See
  [LG's documentation](https://webostv.developer.lge.com/faq/can-i-use-two-video-tags-at-the-same-time).

- **Playback speed:** LG lists playback speeds other than `1.0` as
  unsupported, and the standard `HTMLMediaElement.playbackRate` has no effect
  on webOS. The non-standard `com.webos.media/setPlayRate` Luna API changes
  the speed of file-based movies and episodes (such as MP4 and MKV), but the
  native HLS and DASH pipelines accept the same request and keep playing at
  `1x`, so the player offers no speed control and everything plays at normal
  speed. See
  [LG's streaming specifications](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm).

- **Match frame rate (auto frame rate, AFR):** webOS gives apps no control
  over the panel refresh rate, and the
  [`mediaOption` parameter](https://webostv.developer.lge.com/develop/guides/mediaoption-parameter)
  has no frame-rate field. None is needed: the TV reads the frame rate from the
  stream and drives the panel to match. On a 2025 OLED running webOS 10.3.1,
  `com.webos.service.videooutput/getStatus` reported the source frame rate
  exactly (23.976, 24, 25, 29.97, 50, and 59.94 fps) for both native `<video>`
  playback and MSE playback, the path Shaka uses. To remove 24p and 25p judder,
  turn on the TV's **Real Cinema** picture setting (called **Cinema Screen** on
  some models).

- **Transparent program guide over the playing video:** a see-through guide
  needs background blur to stay readable, but webOS 4 and 5 do not support
  `backdrop-filter`. On those versions the app replaces translucent overlays
  with opaque panels, so a transparent guide would not look or read the same
  across supported TVs.

- **Embedded subtitles in MKV movies and episodes:** LG officially supports
  only external subtitle files in the native player, although some embedded
  tracks do appear on newer TVs. Showing every embedded track would mean
  streaming the file twice or playing through hls.js, which loses 4K and Dolby
  Vision. The app keeps native playback. As an alternative, have the server
  extract the track to an external subtitle file listed in the Xtream VOD
  info. See
  [LG's forum answer](https://forum.webostv.developer.lge.com/t/how-to-add-subtitle-in-webos-tv/2552/2).

## Design choices

- **Custom color-button mapping:** the remote's color buttons keep the same
  action in every section. Making them configurable would add many states and
  edge cases for a small gain, and remapping only some views would be
  confusing.

