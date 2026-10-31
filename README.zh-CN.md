<div align="center">
  <img src="assets/icon.svg" alt="Pleione 图标">
  <h1>Pleione</h1>
  <p>Merope 出品，一款专为 LG webOS 电视打造的 IPTV 播放器，支持 M3U 播放列表、Xtream Codes 账号、XMLTV 节目指南（EPG）、回看及直播时移。</p>
  <p><a href="README.md">English</a> | 简体中文</p>
  <p>
  <a href="#支持的-webos-版本"><img src="https://img.shields.io/badge/webOS-4%2B-e6007e?logo=webos&logoColor=white" alt="webOS 4+"></a>
  <a href="https://github.com/ahmedsaed/pleione-webos-iptv-player/releases/latest"><img src="https://img.shields.io/github/v/release/ahmedsaed/pleione-webos-iptv-player" alt="最新版本"></a>
  <a href="https://github.com/ahmedsaed/pleione-webos-iptv-player/releases"><img src="https://img.shields.io/github/downloads/ahmedsaed/pleione-webos-iptv-player/total" alt="GitHub 下载量"></a>
  <a href="https://pleione.merope.dev/"><img src="https://img.shields.io/badge/Website-222?logo=github" alt="项目网站"></a>
  </p>
</div>

## 致谢

Pleione 基于 lennylxx 的 [webOS IPTV Player](https://github.com/lennylxx/webos-iptv-player)，遵循 Apache-2.0 许可证。详见 [NOTICE](NOTICE)。

## 截图

| 频道列表 | 直播预览 |
| --- | --- |
| ![频道列表](https://github.com/user-attachments/assets/adb1ff15-1da3-479f-8a2f-0486dca5b082) | ![直播预览](https://github.com/user-attachments/assets/a10915a7-cdea-4bfc-bb12-f6e3054b4b51) |

| 最近观看 | 节目指南 |
| --- | --- |
| ![最近观看](https://github.com/user-attachments/assets/ef7aa7a1-7c3e-4b59-8825-fe4a0a441a61) | ![节目指南](https://github.com/user-attachments/assets/9928c342-c2fa-46b8-92f1-b5e815f24f19) |

| 回看续播 | 频道信息 |
| --- | --- |
| ![回看续播](https://github.com/user-attachments/assets/641a72bf-db7e-4757-ac71-c8add5114c7a) | ![频道信息](https://github.com/user-attachments/assets/9adf8302-750f-429b-9155-828c8c30f097) |

| 播放浮层 | 字幕 |
| --- | --- |
| ![播放浮层](https://github.com/user-attachments/assets/08c81dd7-5811-4fe3-9ed0-3e766d7124f9) | ![字幕](https://github.com/user-attachments/assets/5d1fab57-1087-414b-9a20-f900589eac4a) |

| 字幕搜索 | 电影 |
| --- | --- |
| ![字幕搜索](https://github.com/user-attachments/assets/4ef9c97e-131b-4e4f-bf9a-c753d66f2956) | ![电影](https://github.com/user-attachments/assets/6d4d65c4-9719-4a2f-93a0-2fff4f8c0b2d) |

| 电影详情 | 剧集详情 |
| --- | --- |
| ![电影详情](https://github.com/user-attachments/assets/b1acbc3c-47f7-4cd2-9fe6-f3b3aca03768) | ![剧集详情](https://github.com/user-attachments/assets/2962184e-cc95-455d-aea7-888ff3297dc4) |

| 搜索 | 设置 |
| --- | --- |
| ![搜索](https://github.com/user-attachments/assets/0c6c54e2-6fb3-4fb2-a0da-7f6459815390) | ![设置](https://github.com/user-attachments/assets/8d47b502-ddcf-447f-a6b1-5afbf1b6b9ba) |

| 主题选择器 | 节目提醒 |
| --- | --- |
| ![主题选择器](https://github.com/user-attachments/assets/2e5ed981-c01b-48ab-a681-9a0ecd6431b8) | ![节目提醒](https://github.com/user-attachments/assets/76ed121f-61eb-4c36-93a9-9aa6abdb0132) |

| 家长控制 | 局域网设置 |
| --- | --- |
| ![家长控制](https://github.com/user-attachments/assets/7f22d1c3-97bf-4118-a19f-3699bf2779ba) | ![局域网设置](https://github.com/user-attachments/assets/a618e22f-6dae-474d-870e-13aebc22bf63) |

## 功能

**播放列表和账号**

- **M3U 播放列表** — 支持加载多个 M3U/M3U8 播放列表并自动去重；播放源可临时停用，无需删除原有配置
- **Xtream Codes 账号** — 支持添加、临时停用账号，并可通过主页上的头像快速切换；播放列表和 EPG 数据将根据账号凭据自动获取
- **局域网设置** — 扫描二维码后，即可通过同一局域网内的手机配置播放源和在线字幕，或上传 `.m3u` 文件（[局域网服务](docs/lan-service.md)）

**直播与视频点播**

- **节目指南（EPG）** — 以时间网格显示在直播页中、分组栏旁（按红色键切换），自动生成日期范围，支持按播放源校正节目时间；数据经缓存后可快速再次打开
- **频道健康检查** — 检测直播流状态，并将频道标记为正常、可疑或不可用
- **节目提醒** — 为即将播出的节目设置提醒；即使应用已经关闭，也能在开播时收到通知并直接切换至对应频道
- **最近观看** — 快速返回最近收看的直播频道，或从上次进度继续播放回看节目
- **直播预览** — 浏览频道列表时在右侧持续播放，并提供节目信息和快捷控制
- **电影和剧集** — 浏览 Xtream 账号提供的视频点播（VOD）内容，并按账号分别维护“继续观看”和“稍后观看”列表
- **片库排序** — 电影和剧集可按名称、加入日期、评分或年份升序或降序排列，两个分区分别记住各自的排序方式
- **管理“继续观看”和“稍后观看”** — 可逐个移除影片、清空整个列表，或在电影详情页清除观看进度
- **视频点播自动连播队列** — 自动接续播放后续剧集或“稍后观看”中的电影，并在播放完成后将其移出列表
- **回看与直播时移** — 播放已播出的节目；观看直播时可暂停、回退或一键返回直播点
- **家长控制** — 使用 PIN 锁定直播分组、电影和剧集分类或单个节目，并建议锁定疑似成人内容的分组；锁定的内容可带锁显示或隐藏，并可设置何时再次要求输入 PIN

**播放**

- **原生 HDR 与 Dolby 直通** — 视频流直接交由电视的原生解码器处理，完整保留 HDR10、HLG、Dolby Vision® 和 Dolby Atmos® — **[为何选择原生播放而非 hls.js？查看真机对比](docs/native-vs-hls.js.md)**
- **MPEG-DASH 播放** — 明文和 PlayReady `.mpd` 频道使用 webOS 原生媒体管线，Widevine/ClearKey 频道按需启用 Shaka MSE/EME；支持 MPD 轨道元数据、直播时移和字幕（[详情](docs/mpeg-dash.md)）
- **原生 PlayReady DRM** — 在兼容的 webOS 电视上，通过 LG DRM 服务和原生硬件媒体管线播放受保护的 MPEG-DASH 频道，并从 Kodi 风格的 M3U 属性读取授权设置（[详情](docs/mpeg-dash.md)）
- **Widevine / ClearKey DRM** — 按需加载 Shaka DASH-only 引擎，支持 Kodi 风格的授权地址、请求头和经过校验的 ClearKey 内联密钥（[详情](docs/mpeg-dash.md)）
- **音轨与字幕轨道** — 可从播放控件中选择，并按频道或点播项目分别记忆。直播字幕支持 HLS 清单内的 WebVTT 和 CEA-608/708；点播字幕支持内封字幕及外挂 SRT、WebVTT、ASS。还可通过 SubDL、OpenSubtitles 和 Assrt 在线搜索，或手动输入片名；即使媒体自带字幕，在线搜索仍然可用，并支持播放期间实时调整字幕同步
- **OSD（屏幕显示）** — 显示节目名称、播放进度及码流信息，包括分辨率、HDR、帧率、编解码器和音频声道
- **电视风格播放控件** — 左/右键快退/快进 10 秒（按住可加速），支持上一集/下一集；仅当媒体提供多个选项时才显示音轨和字幕按钮；直播另有收藏和频道信息按钮
- **自动播放故障恢复** — 检测无法开始播放或播放卡住的流，自动重新加载临时故障；若多次恢复失败，则切换至下一个直播频道

**导航**

- **主页** — 启动后的首屏：直播、电影、剧集、搜索和设置大卡片，以及时钟和账号头像；各版块全屏打开，并各自加载所需数据
- **全局搜索** — 同时搜索频道、EPG 节目、电影和剧集，并可从搜索结果直接观看直播、播放回看或设置提醒；搜索框下方会列出最近搜索，一键即可再次搜索；搜索索引会在后台预先构建并缓存，打开搜索几乎无需等待
- **频道侧边栏** — 在全屏播放时按左键，无需离开播放画面即可按分组切换频道，并查看当前节目信息
- **频道自定义** — 支持调整顺序、隐藏、重命名、重新分组和管理收藏，还可修正各频道的 EPG 匹配及时间偏差
- **类型分组图标** — 让内容浏览更加快捷
- **数字键选台** — 在频道列表或播放界面按遥控器数字键输入频道号直接切换，并在屏幕上显示输入中的数字
- **全面支持 LG 遥控器与动感遥控器** — 所有界面均支持方向键空间导航和指针操作
- **动感遥控器边缘滚动** — 将指针停在片库或搜索结果横排或长列表的边缘即可自动滚动，停留越久滚动越快
- **多款配色主题** — 可实时预览并选择全局浅色或深色主题，播放器浮层另有深色和毛玻璃样式可选；所有选择均会自动保存
- **文字大小可调** — 在不改变控件尺寸的前提下，可将文字缩放至 80%–150%
- **界面大小** — 在 90%–130% 范围内同时缩放文字、图片和控件，整体放大或缩小界面
- **动画模式** — “基础”在较旧的电视上关闭高开销的动态效果，“均衡”保留视觉效果但立即滚动到焦点项，“完整”在单次导航时平滑滚动
- **多语言界面** — 支持 English、العربية、Deutsch、Español、Français、Italiano、Polski、Português (Brasil)、Русский、Türkçe、Українська 和简体中文；默认跟随电视的系统语言，也可在设置中手动指定

**开发**

- **桌面预览** — 使用 HLS.js、mpegts.js 和 Shaka 在浏览器中预览播放效果

## 不支持的功能与限制

部分功能受 webOS 平台限制或出于设计考虑而未提供，详见[完整列表](docs/unsupported-features.md)。

## 支持的 webOS 版本

本应用支持 **webOS 4.0（2018 年）及以上版本**，最低兼容基线为 webOS 4
所搭载的 Chromium 53。后续 webOS 版本均采用更新的 Chromium 内核，因此
可保持向前兼容。对于 flex `gap`、`backdrop-filter` 等仅由较新内核原生
支持的特性，应用会通过特性检测在旧版系统上启用兼容方案。

| webOS 版本 | 发布年份 | Chromium 引擎 | 内置服务 Node.js | 支持状态 |
| --- | --- | --- | --- | --- |
| webOS 4.x | 2018–2019 | 53 | 0.12.2 | ✅（最低版本） |
| webOS 5.0 | 2020 | 68 | 8.12.0 | ✅ |
| webOS 6.0 | 2021 | 79 | 8.12.0 | ✅ |
| webOS 22 | 2022 | 87 | 12.21.0 | ✅ |
| webOS 23 | 2023 | 94 | 12.22.2 | ✅ |
| webOS 24 | 2024 | 108 | 16.19.1 | ✅ |
| webOS 25 | 2025 | 120 | 16.20.2 | ✅ |
| webOS 26 | 2026 | 132 | 20.12.2 | ✅ |

不支持 webOS 3.x 及更早版本（Chromium 38 及更早版本）。

## 前置要求

通过命令行安装应用或在本地构建项目，需要
[Node.js](https://nodejs.org/)（v22 或更高版本）以及
[webOS CLI 工具](https://webostv.developer.lge.com/develop/tools/cli-installation)：

```bash
npm install -g @webos-tools/cli
```

## 安装到电视

Pleione 即将上架 LG Content Store。在此之前，可以通过 LG 的开发者模式
（Developer Mode）应用侧载安装。另请参阅
[安装指南](https://pleione.merope.dev/setup/)（英文）。

### 开发者模式

开发者模式的会话有时间限制。请在到期前通过 Developer Mode 应用续期：
会话过期后，电视会移除以此方式安装的应用。

1. **下载应用安装包。** 在电脑上打开
   [Releases 页面](https://github.com/ahmedsaed/pleione-webos-iptv-player/releases/latest)，
   下载最新的 `.ipk` 文件。

2. **在电视上开启开发者模式。**
   - 在 [LG webOS Developer 网站](https://webostv.developer.lge.com/)免费注册账号。
   - 在电视上打开 **LG Content Store**，搜索并安装 **Developer Mode** 应用。
   - 使用 LG 开发者账号登录，将 **Dev Mode Status** 切换为 **ON**。
     电视随后会重启。请记下应用中显示的 **IP 地址**和**密码短语**。

3. **注册电视设备。** 将电视添加为名为 `tv` 的设备
   （请将示例 IP 替换为电视的实际地址）：

   ```bash
   ares-setup-device --add tv -i "username=prisoner" -i "host=127.0.0.1" -i "port=9922"
   ```

   然后获取设备密钥，并在提示时输入 Developer Mode 应用中显示的
   **密码短语**：

   ```bash
   ares-novacom --device tv --getkey
   ```

4. **安装应用。**

   ```bash
   ares-install --device tv ./com.merope.pleione_<version>_all.ipk
   ```

## 开发

### 安装依赖

```bash
npm install
```

### 构建

```bash
./build.sh
```

### 构建并安装到电视

```bash
./build.sh --install [device-name]
```

如未指定设备名称，脚本将使用 `ares-setup-device` 中配置的默认设备。

### 在电视上调试

Windows 请使用 WSL 2；不支持原生 Windows 环境。

`scripts/tv.sh` 会自动读取 `ares-setup-device` 中默认设备的连接信息，
无需在命令中手动填写密钥或密码短语。

```bash
scripts/tv.sh logs --app com.merope.pleione       # 实时查看应用的 DevTools 控制台
scripts/tv.sh eval 'document.visibilityState'    # 在应用页面中执行 JavaScript
scripts/tv.sh perf --duration 30                 # 采样 CPU、堆、DOM 和布局
scripts/tv.sh diag                               # 生成经过脱敏的诊断报告
scripts/tv.sh capt screenshot screen.png         # 截取电视画面和应用 OSD
scripts/tv.sh capt record screen.mp4             # 录制 10 秒电视画面，约 5 fps，无音频
scripts/tv.sh input key down ok red              # 按遥控器按键
scripts/tv.sh input click 700 450                # 移动 Magic Remote 指针并点击
scripts/tv.sh input wheel 3                      # 在指针处向下滚动滚轮 3 格
scripts/tv.sh input key power                    # 关闭电视
scripts/tv.sh input wake                         # 开启电视（Wake-on-LAN）
scripts/tv.sh run 'uname -a'                     # 通过 SSH 在电视上执行命令
scripts/tv.sh push ./file.txt /tmp/file.txt      # 将本地文件复制到电视
scripts/tv.sh pull /tmp/file.txt ./file.txt      # 将电视文件复制到本地
scripts/tv.sh shell                              # 打开交互式 SSH 会话
scripts/tv.sh reboot                             # 通过 Luna 重启电视
TV_DEVICE=tv2 scripts/tv.sh logs                 # 选择非默认的已配置电视
```

运行 `scripts/tv.sh logs --help`（`eval`、`perf`、`diag`、`capt`、`input`
同理）可查看相关选项。

### 在浏览器中预览

```bash
npm run preview
```

预览服务将在 http://localhost:3000 打开。桌面端分别通过 HLS.js、
mpegts.js 和 Shaka 播放相应格式的视频。

### 演示 Xtream 服务器

```bash
npm run xtream:demo
```

提供合成的 Xtream 内容目录，并使用本地生成的真实媒体（需要 ffmpeg），
可在预览中或同一局域网内的电视上进行测试。详见
[`docs/xtream-demo-server.md`](docs/xtream-demo-server.md)。

## 设置

按遥控器上的**蓝色键**，或选择主页上的**设置**卡片即可进入设置。
各项功能如下：

- **语言** — 默认跟随电视的系统语言，也可手动指定界面语言。
- **使用手机或电脑设置** — 扫描二维码后通过手机配置应用，或在电脑上打开页面并输入配对码。
- **家长控制** — 设置 PIN；锁定直播分组、电影和剧集分类或单个节目；锁定的内容可带锁显示或隐藏，并可设置何时再次要求输入 PIN。
- **Xtream 账号** — 添加、编辑、删除或临时停用账号；检查登录信息、连接占用和到期时间；为直播流选择 TS、HLS 或自动格式；还可在**直播分类**中只加载选中的分类，并可选择自动显示新分类。保存后，应用会根据账号信息自动获取播放列表和 EPG。
- **播放列表** — 添加、编辑、删除或临时停用 M3U 播放列表地址；更改将在保存后生效。
- **上传播放列表** — 显示通过“使用手机或电脑设置”上传的播放列表，并可临时停用或删除。新的上传会通过 Luna 消息自动同步到列表中。
- **频道** — 检查直播流健康状态；调整频道顺序，隐藏、重命名或重新分组频道；手动匹配 XMLTV 频道，或校正单个频道的 EPG 时间；还可显示隐藏频道或重置所有自定义设置。
- **手动 XMLTV 源** — 可添加多个节目指南地址，按从上到下的顺序确定优先级，并为每个源选择适用于所有播放列表或指定播放列表。应用也会自动读取 M3U 播放列表中的 `url-tvg`、`x-tvg-url` 或 `tvg-url`。
- **节目指南时区** — 选择以电视的**设备**时区或节目指南的**节目源**时区显示节目时间。
- **EPG 时间校正** — 以 15 分钟为步长，分别校正各播放源的节目时间。
- **节目提醒** — 打开按日期分组的节目提醒管理器，查看或移除尚未播出的提醒。
- **外观** — 实时预览应用配色主题，选择深色或毛玻璃播放器浮层，调整界面大小（90%–130%），并在 80%–150% 范围内调整文字大小。
- **播放** — 选择频道上/下键是在全局频道列表中切换，还是限制在
  当前分组、收藏或播放列表内。
- **在线字幕** — 选择首选字幕语言，并配置 SubDL、OpenSubtitles 和 Assrt 的在线搜索凭据。还可选填你自己的 TMDB API 密钥（v3 密钥或 v4 读取访问令牌），在电影和剧集页面显示演员照片；未填写时，应用不会访问 TMDB。
- **高级设置** — 自定义高级界面、播放和后台刷新行为。
- **数据管理** — 刷新数据、清除缓存或观看记录，以及重置应用。
- **保存更改**会应用当前设置；播放源发生变化时，还会重新加载播放列表和节目指南。选择**取消**则放弃本次修改。

## 遥控器按键映射

| 按键 | 主页 | 直播 | 节目指南（直播内） | 播放器 |
| --- | --- | --- | --- | --- |
| 上/下 | 在卡片间移动 | 在分组或频道间移动；在顶部按上键进入页头 | 上一个/下一个频道；在第一行按上键进入页头 | 切换至上一个/下一个频道（直播）；显示播放控件（电影、剧集）；在控件中切换行 |
| 左/右 | 在卡片间移动 | 在分组栏和频道栏之间移动 | 查看更早/更晚的节目；在最早处按左键进入分组栏 | 后退/前进 10 秒（电影、剧集；回看和直播 DVR 需显示控件），按住可加速；否则按左键打开频道侧边栏 |
| 确定/Enter | 打开当前版块 | 全屏播放当前频道 | 观看、设置提醒或播放回看 | 暂停或继续播放并显示控件（电影、剧集）；打开控件（直播）；操作当前控件 |
| 返回 | 关闭应用 | 返回主页（编辑频道时先退出编辑） | 返回分组栏，再返回主页 | 逐级关闭侧边栏、选择列表或控件；再返回开始播放的位置 |
| 红色键 | 打开节目指南 | 切换至节目指南 | 切换至频道列表 | 打开节目指南 |
| 绿色键 | — | 收藏或取消收藏当前频道 | — | 收藏或取消收藏（显示侧边栏或直播控件时） |
| 黄色键 | — | 编辑频道列表 | — | 显示频道信息 |
| 蓝色键 | 打开设置 | 打开设置 | 打开设置 | 打开设置 |
| 停止 | — | 停止预览，直到焦点移动 | — | — |
| 播放/暂停 | — | — | — | 暂停/继续播放 |
| 快退/快进 | — | — | — | 跳至最早可播放位置/返回直播（直播 DVR） |
| 频道 +/- | — | 切换至上一个/下一个频道 | 按页切换频道 | 切换至上一个/下一个频道 |
| 0–9 | 输入频道号直接跳转 | 输入频道号直接跳转 | — | 输入频道号直接跳转 |

电影、剧集、搜索、设置和节目提醒界面均使用标准方向键导航。按**返回**键
总是返回上一级：从详情页返回浏览页，从设置子页面返回设置，从各版块返回
主页，在主页按返回键则关闭应用。

## 技术文档

以下文档面向项目贡献者，深入介绍部分功能的实现方式及 webOS
平台特有行为：

- [`docs/native-vs-hls.js.md`](docs/native-vs-hls.js.md) — 真机为何使用原生 `<video>` 媒体管线而非 hls.js，以及 HDR 和 Dolby 直通的实现原理
- [`docs/audio-track-selection.md`](docs/audio-track-selection.md) — 原生 webOS 播放器的音轨切换机制
- [`docs/hls-subtitles.md`](docs/hls-subtitles.md) — webOS 上的直播 HLS 字幕处理方式，包括清单内字幕格式及其渲染路径
- [`docs/mpeg-dash.md`](docs/mpeg-dash.md) — DASH 格式检测、原生播放、字幕和直播 DVR 的实现
- [`docs/vod-subtitles.md`](docs/vod-subtitles.md) — Xtream 电影与剧集的字幕实现，包括容器内字幕、外挂 SRT/WebVTT/ASS 字幕，以及 SubDL、OpenSubtitles 和 Assrt 在线搜索
- [`docs/storage-and-data.md`](docs/storage-and-data.md) — 应用的数据存储范围与位置，以及用户数据和临时缓存的隔离方式
- [`docs/lan-service.md`](docs/lan-service.md) — 通过内置局域网服务完成手机端设置和 M3U 文件上传
- [`docs/xtream-demo-server.md`](docs/xtream-demo-server.md) — 本地演示 Xtream 服务器，提供合成目录和真实媒体，用于手动测试
- [`docs/unsupported-features.md`](docs/unsupported-features.md) — webOS 不允许或有意不提供的功能，以及替代方案

## 许可证与第三方声明

本项目使用 [Apache-2.0](LICENSE) 许可证。第三方软件与图标保留各自的许可证，
详见[来源与署名清单](THIRD_PARTY_NOTICES.txt)。每次构建都会将 `LICENSE`、
`THIRD_PARTY_NOTICES.txt` 和 `licenses/` 目录放入 `dist/`，随安装包一起分发。
此清单仅覆盖正式安装包，不包含仅供本地开发的桌面预览播放库。
