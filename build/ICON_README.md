# 应用图标

打包前请将 256×256 的 `.ico` 文件放在此目录并命名为 `icon.ico`。

## 制作方法

1. 准备一张 1024×1024 PNG 图片
2. 使用工具转换为 ICO（含 16/32/48/64/128/256 多尺寸）：
   - 在线工具：https://icoconvert.com
   - 命令行（需安装 ImageMagick）：
     ```
     magick convert icon.png -define icon:auto-resize="256,128,64,48,32,16" icon.ico
     ```
3. 将生成的 `icon.ico` 放到此目录

## 如果暂时没有图标

可以先删除 package.json 中 `win.icon` 配置，electron-builder 会使用默认图标：

```json
"win": {
  "target": "nsis"
}
```
