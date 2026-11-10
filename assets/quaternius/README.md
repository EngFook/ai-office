# 第三方 3D 素材（V8a 逼真人物原型）

本目录保存 V8a 使用的第三方绑骨人物素材的**原始源文件**。
`public/figure-v8a.glb` 是 `platformer-game-kit/Character.glb` 的原样副本，
运行时只在 V8a 特性开关打开（默认关闭）时按需加载。

## 来源与许可

| 素材 | 所属素材包 | 作者 | 许可 | 获取渠道 |
| --- | --- | --- | --- | --- |
| `platformer-game-kit/Character.glb`（绑骨人物，2908 面 / 1895 顶点，29 根骨骼，内嵌 18 段动作，含 Idle 与 Walk） | Quaternius Platformer Game Kit | Quaternius (quaternius.com) | CC0 1.0 | 官方包页 `https://quaternius.com/packs/ultimateplatformer.html`；单文件取自社区镜像 `https://github.com/trebeljahr/quaternius-showcase`（`public/glb/platformer_game_pack/Character.glb`，其 `LICENSES.md` 标注该包为 CC0-1.0，2026-11-02 下载） |

- CC0 1.0（公有领域贡献）：可自由用于个人、教育与商业项目，无署名义务；
  按作者建议在此致谢 **Quaternius / quaternius.com**。
- 模型为纯色低模（无贴图），材质 `Main` 的顶点在运行时按团队色重染；
  `Ears` 网格（240 面）在加载时丢弃，实际渲染 2668 面 / 1663 顶点。
- 坐姿打字 / 休息坐两段动作素材包里没有，由 `src/figure-vat-bake.js`
  在烘焙顶点动画贴图（VAT）时基于 Idle 姿态对同一骨架程序化摆姿生成。
- 会议纪要（2026-11-02 3D 逼真度会议）约定只使用 Quaternius / Kenney /
  Poly Haven 的 CC0 素材；V8a 使用 Quaternius。
