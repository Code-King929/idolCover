# 🎤 偶像新歌翻唱助手 · IdolCover Studio

一款基于 Web Audio API 的在线翻唱工具，纯前端实现，无需后端服务器。

## ✨ 核心功能

- 🎤 **一键翻唱**：上传歌曲或选择预置歌曲即可开始翻唱
- 🎧 **AI 智能降调**：支持男声女声互转，推荐降调方向
- 👥 **粉丝合唱**：多人录音叠加混音
- 🎯 **AI 音准分析**：录制完成后自动生成音准评分和改进建议
- 💾 **一键导出**：支持 WAV / MP3 格式导出

## 🛠️ 技术栈

- **Web Audio API**：音频处理、实时变调、录音
- **MediaRecorder**：浏览器原生录音
- **ONNX Runtime Web**：可选的 AI 推理（Demucs 人声分离）
- **LameJS**：MP3 编码
- **Canvas**：波形可视化
- **纯前端**：HTML + CSS + JavaScript

## 📁 项目结构

```
idolcover-studio/
├── index.html          # 主页面
├── app.js              # 核心逻辑
├── styles.css          # 样式
└── audio/              # 预置歌曲
    ├── Excitant.mp3
    ├── 漂洋过海来看你.mp3
    ├── 唐人.mp3
    └── 小幸运.mp3
```

## 🚀 本地运行

由于浏览器 CORS 限制，需要通过 HTTP 服务器访问：

```bash
# Python 3
python -m http.server 8080

# Node.js
npx http-server -c-1 -p 8080

# PHP
php -S localhost:8080
```

然后在浏览器中访问：`http://localhost:8080`

## 🌐 在线预览

通过 GitHub Pages 部署后访问：[在线链接](https://你的用户名.github.io/idolcover-studio/)

## 📝 许可证

MIT License
