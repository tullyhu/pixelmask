# PixelMask

本地照片 / 视频脱敏工具：在视频中圈选区域或自动识别人脸，自动跟踪并应用马赛克 / 高斯模糊 / 黑框，导出 MP4。所有处理均在设备本地完成，不上传任何数据。

> 静态照片脱敏功能正在规划中（Planned: still-photo redaction）。

## 架构

- **前端**：Tauri 2 + React（`src/`）
- **原生引擎**：SwiftPM 可执行程序（`native-engine/`），仅使用 Apple 系统框架：
  - 人脸检测：Vision `DetectFaceRectanglesRequest`
  - 目标跟踪：Vision `TrackObjectRequest`（含速度外推与反向跟踪）
  - 渲染：CoreImage（`CIPixellate` / 模糊 / 黑框）+ `VNGeneratePersonSegmentationRequest` 人像分割
  - 导出：AVFoundation
- 前端与引擎通过 127.0.0.1 回环 HTTP（端口 8765）通信，引擎随 App 打包（Tauri externalBin）

不包含任何第三方 ML 模型。

## 构建

要求：macOS 15+，Xcode（Swift 6 工具链），Rust，Node.js。

```bash
npm install
npm run engine        # 构建原生引擎并复制到 src-tauri/binaries/
npm run tauri dev     # 开发模式
npm run tauri build   # 打包 PixelMask dmg（Apple Silicon）
```

引擎也可单独调试：`npm run engine:dev`（监听 127.0.0.1:8765）。

## 隐私政策

`privacy/` 为隐私政策静态页（Cloudflare Workers 部署）。

## 许可

本项目以 [MIT](LICENSE) 协议开源。第三方组件许可声明见
`licenses/THIRD-PARTY-LICENSES.txt`（应用内「ⓘ 关于与开源许可」中也可查看）。
