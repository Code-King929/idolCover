# 🎤 偶像新歌翻唱助手 · IdolCover Studio

一款基于 Web Audio API 的在线翻唱工具，纯前端实现，无需后端服务器。

## ✨ 核心功能

- 🎤 **一键翻唱**：上传歌曲或选择预置歌曲即可开始翻唱
- 🎧 **AI 智能降调**：支持男声女声互转，自动推荐最佳降调幅度
- 🎵 **人声分离**：基于谱减法 + 中置通道提取的前端算法，分离人声与伴奏
- 👥 **粉丝合唱**：多人录音叠加混音，支持参考音轨模式
- 🎯 **AI 音准分析**：录制完成后自动生成音准评分和改进建议
- 💾 **一键导出**：支持 WAV / MP3 格式导出

## 🛠️ 技术栈

- **Web Audio API**：音频处理、实时变调、录音
- **MediaRecorder**：浏览器原生录音
- **OfflineAudioContext**：人声分离算法
- **Phase Vocoder**：粒状变调算法
- **LameJS**：MP3 编码
- **Canvas**：波形可视化、音准曲线绘制
- **纯前端**：HTML + CSS + JavaScript，离线可用

## 📁 项目结构

```
idolCover/
├── index.html          # 主页面
├── app.js              # 核心逻辑（音频处理、录音、混音）
├── styles.css          # 样式（蓝色清爽风格）
├── audio-data.js       # 音频数据加载模块
└── audio/              # 预置歌曲（Base64 格式）
    ├── excitant_base64.txt
    ├── beyond_the_sea_base64.txt
    ├── tang_people_base64.txt
    └── lucky_star_base64.txt
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

GitHub Pages 部署：[https://code-king929.github.io/idolCover/](https://code-king929.github.io/idolCover/)

> ⚠️ 首次加载可能较慢（预置歌曲使用 Base64 格式），加载完成后浏览器会自动缓存。

## 🎯 比赛评分维度

| 维度 | 实现内容 |
|------|----------|
| **创新性** | 前端人声分离算法、实时变调预览、AI 音准分析 |
| **实用性** | 一站式翻唱流程、支持合唱拼接、多格式导出 |
| **完成度** | 四步流程完整实现、交互体验优化 |
| **美观度** | 蓝色清爽风格、玻璃拟态设计、响应式布局 |

## 📝 许可证

MIT License
