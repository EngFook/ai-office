# 第三方 3D 素材（V6 桌面小物件）

本目录保存 V6 使用的第三方低模素材的**原始源文件**与许可证。运行
`node scripts/convert-desk-props.mjs` 会把它们转换成 `src/desk-prop-data.js`
（已提交的生成文件），运行时不加载本目录。

## 来源与许可

| 素材 | 所属素材包 | 作者 | 许可 | 获取渠道 |
| --- | --- | --- | --- | --- |
| `furniture-kit/computerScreen.obj`（显示器，72 面） | Kenney Furniture Pack 1.0 | Kenney (www.kenney.nl) | CC0 1.0 | 作者在 OpenGameArt 的官方发布镜像 `https://opengameart.org/content/furniture-kit`（kenney_furniturePack.zip，2017-11-30） |
| `furniture-kit/computerKeyboard.obj`（键盘，32 面） | 同上 | 同上 | CC0 1.0 | 同上 |
| `furniture-kit/plantSmall2.obj`（小盆栽，158 面） | 同上 | 同上 | CC0 1.0 | 同上 |
| `food-kit/cup-coffee.obj` + `Textures/colormap.png`（咖啡杯，216 面） | Kenney Food Kit 2.0 | Kenney (www.kenney.nl) | CC0 1.0 | 作者在 OpenGameArt 的官方发布镜像 `https://opengameart.org/content/food-kit`（kenney_food-kit.zip，2024-06-26） |

- 两个素材包的原版 `License.txt`（CC0 声明）原样保存在各自子目录。
- CC0 1.0（公有领域贡献）：可自由用于个人、教育与商业项目，无署名义务；
  按作者建议在此致谢 **Kenney / www.kenney.nl**。
- Furniture Pack 的颜色来自 `.mtl` 的 Kd 漫反射色；Food Kit 的颜色来自
  `colormap.png` 调色板贴图（转换脚本按 UV 采样后烘焙成共享调色板）。
- 会议纪要（2026-11-02 3D 逼真度会议）约定只使用 Quaternius / Kenney /
  Poly Haven 的 CC0 素材；V6 实际只用到了 Kenney。
