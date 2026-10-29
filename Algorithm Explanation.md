# HRT‑Recorder Pharmacokinetic Models

This README explains the algorithms used for each drug/route, key parameters and units, what was tuned, why we tuned it, and how the implementation evolved.

---

## 0) 总览（模型架构）

**目标**：用一套轻量的、可解释的 PK 近似模型，覆盖常见雌激素制剂与给药途径，在手机端实时算出血药浓度–时间曲线与 AUC。

**核心构件（与代码一一对应）**
- **DoseEvent**：一次给药事件，带路由、时间、剂量、酯别与一些附加字段（如凝胶面积、贴片标称释放速率 µg/day）。
- **ParameterResolver**：把事件映射为具体参数 `PKParams`（k₁/k₂/k₃、F、双库或双通路比例、零阶速率等）。
- **ThreeCompartmentModel**：解析解工具箱：
  - 三室模型（首过吸收 k₁ → 酯水解 k₂ → 游离 E2 清除 k₃）的解析式。
  - 单室 Bateman 形式（口服简化）。
  - 经皮凝胶三层级联（表面 → 皮肤贮库 → 系统中心室）的解析式（见 §4）。
  - 双通路舌下模型（快：口腔黏膜；慢：吞咽 = 口服；**E2: dualAbsAmount；EV: dualAbs3CAmount**）。
  - 贴片：零阶输入在佩戴窗口内，移除后按 k₃ 衰减；或旧版一阶“假库”。
- **SimulationEngine**：把一堆 `DoseEvent` 预编译为时间→量的函数，遍历时间点，线性叠加各事件的中心室药量，再以体分布换算为浓度，AUC 用梯形法则积分。

**单位与换算**
- 剂量 `doseMG` 以 mg 计；中心室药量计算单位也是 mg。
- 浓度输出为 pg/mL：`conc = amountMG × 1e9 / Vd_ml`。
- 体分布体积：`Vd = vdPerKG × BW`，其中 `vdPerKG` 默认 **2.0 L·kg⁻¹**（可在设置中调整）。
- **输入剂量均已按 E2 等效（E2‑eq）换算**；因此各路由的 `F` 不再乘以分子量换算因子。 `EsterInfo.toE2Factor` 仅用于显示/对照，不参与计算。

---

## 1) 公共参数（`PKparameter.swift :: CorePK`）

| 名称 | 含义 | 默认值 | 备注 |
| --- | --- | --- | --- |
| `vdPerKG` | 表观分布容积（每 kg） | 2.0 L·kg⁻¹ | 移动端可配置；用于 mg → pg/mL 换算 |
| `kClear` | 游离 E2 清除速率常数 k₃ | 0.41 h⁻¹ | 对应 t½ ≈ 1.69 h；为经验标定值，用于与项目中目标曲线贴合 |
| `kClearInjection` | 注射专用游离 E2 清除速率常数 k₃（仅 injection 路由使用） | 0.05 h⁻¹ | 保持 flip‑flop 形状以匹配 EEN/EV/EC 的 Tmax/Cmax，不等同于生理清除 |
| `depotK1Corr` | 注射两库 k₁ 的全局校正系数 | 1.0 | 改峰/拖尾时可整体缩放注射的 k₁ |

> 注：`kClear` 是游离 E2 中心室的表观清除常数，其锚点来自贴片移除后的终末半衰期（≈ 1–2 h），在此基础上取中间值 **0.41 h⁻¹** 以兼顾舌下与贴片的日内回落。它服务于本项目的简化模型与多路叠加稳定性，并不等价于群体生理清除率，不应外推到人群参数。

**关于 kClear 的来龙去脉**
- **锚点来源**：最初把 `kClear` 定在 1–2 小时的半衰期区间，是依据某些雌二醇贴片的说明书与审评资料对“移除贴片后”的血药下降描述。贴片移除时外源输入为零，后续的下降主要由系统清除主导，因此该时段的终末斜率可以近似视为清除常数 k₃ 的体现。
- **数值选择**：按 `t½ = 1–2 h` 反推 `k = ln2 / t½ ≈ 0.35–0.69 h⁻¹`，本项目选择中间值 `kClear = 0.41 h⁻¹`（`t½ ≈ 1.69 h`），既能匹配贴片移除后的回落节奏，也与舌下日内回落经验相符。
- **为什么不用口服去估**：口服 Bateman 场景下常见 flip‑flop 现象，当吸收速率 `ka` 与或小于清除速率 `ke` 时，终末相斜率反而更像 `ka` 而非 `ke`，因此不适合作为清除常数的锚点。相对地，贴片在移除后 `ka = 0`，终末相更干净。

**注射专用 `kClearInjection`（有效参数说明）**  
注射油剂的末端斜率主要受“从油性贮库进入血液”的缓慢输入所支配（flip‑flop）。为在简化一室清除的前提下复现文献级别的 EEN/EV/EC 峰时与长尾，注射路径使用了 **`kClearInjection = 0.05 h⁻¹`**。它是为**形状校准**而设的有效参数，并不等同于生理清除。  
- 仅在 `event.route == .injection` 时使用；其他路由继续使用 `kClear = 0.41 h⁻¹`。  
- 这样可在不增加额外分布/代谢池的情况下，保持注射曲线的吸收限速形状（天级 Tmax、较平稳的稳态）。  
- 若需生理可解释性更强的估计，应考虑在模型中显式加入贮库/结合/可逆代谢池而非调整清除常数。

---

## 2) 注射油剂（EV/EB/EC/EN）

### 2.1 模型与参数路径
- **模型**：两并联“库”吸收 → 酯水解 → 清除。
- “快库”控制峰时与峰高（Tmax/Cmax），“慢库”控制尾相（半衰期）。
- 解析解使用三室模型：吸收 k₁、酯水解 k₂、清除 k₃。
- **参数来源**：`TwoPartDepotPK`、`EsterPK.k2`、`InjectionPK.formationFraction`、`EsterInfo.toE2Factor`、`CorePK.kClear`、`CorePK.depotK1Corr`。
- **代码入口**：`ParameterResolver.resolve(... case .injection ...)` → `ThreeCompartmentModel.injAmount(...)`。

### 2.2 关键数值（默认）

| 酯 | Frac_fast | k1_fast (h⁻¹) | t½_fast (h) | k1_slow (h⁻¹) | t½_slow (h) | k2 (h⁻¹) | t½_hydrolysis (h) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EB | 0.90 | 0.144 | 4.81 | 0.114 | 6.08 | 0.090 | 7.70 |
| EV | 0.40 | 0.0216 | 32.08 | 0.0138 | 50.23 | 0.070 | 9.90 |
| EC | 0.229164549 | 0.005035046 | 137.66 | 0.004510574 | 153.67 | 0.045 | 15.40 |
| EN | 0.05 | 0.0010 | 693.15 | 0.0050 | 138.63 | 0.015 | 46.21 |

*注：注射路径的清除常数采用 `k3 = kClearInjection = 0.05 h⁻¹`。*

### 2.3 生物利用度（形成分数 F）
- 形成游离 E2 的经验分数 `InjectionPK.formationFraction[ester]`。本项目剂量已按 E2‑eq 输入，**因此 `F = formationFraction`**。

**当前 `formationFraction`（预乘 `toE2Factor` 之前）**  
| 酯 | formationFraction |
| --- | ---: |
| EB | 0.1092237647 |
| EV | 0.0622582882 |
| EC | 0.117255838 |
| EN | 0.12 |
这些数值为经验标定项，用于在不同酯别间保持相对关系的同时，将单次给药的 $C_{\max}/T_{\max}$ 和稳态峰谷对齐到文献级别的量级。

- **调参缘由**：临床/社区曲线显示注射后总体暴露较口服/经皮显著更高，且不同酯别水解率不同，故在保持相对关系的同时加入了经验倍数以贴实峰值与 AUC。

### 2.4 数学形式（概念）
- 两个并联吸收库按 `Frac_fast` 和 `1 − Frac_fast` 分药量，分别以 `k1_fast` 与 `k1_slow` 进入“酯”室，水解为 E2 后以 `k₃` 清除。
- 解析解采用三指数线性组合；当速率接近时采用极限形式（避免除零）。

### 2.5 模型尝试与取舍
- 先前的“单库吸收”很难同时兼顾峰与长尾，因此改为两库模型。
- 尝试过浓度依赖的清除（早期“hill/浓度反馈”想法），在实际叠加多事件时容易引入非物理解耦与数值不稳，最终回退为常数 `k₃`。
- 保留 `depotK1Corr` 作为一键全局微调旋钮，用于不同品牌或溶剂粘度的整体系数修正。

---

## 3) 贴片（E2）

### 3.1 路由与参数
- **两种实现**：  
  1) **零阶输入**：当事件带 `extras[.releaseRateUGPerDay]` 时，按标称 µg/day 转 mg/h 注入中心室，移除后按 `k₃` 衰减。  
  2) **一阶近似（遗留）**：若未提供标称释放率，则用 `PatchPK.generic = .firstOrder(k1: 0.0075 h⁻¹)` 作为高载量贴片的近似。
- **佩戴窗口**：`patchApply` 到随后的 `patchRemove` 之间的时间跨度 `wearH`。

- **零阶**：  
  佩戴期（`0 ≤ t ≤ wearH`）：
  
  $$
  A(t) = \frac{\text{rateMGh}}{k_3} \,(1 - e^{-k_3 t})
  $$
  
  移除后（`t > wearH`）：
  
  $$
  A(t) = A(\text{wearH})\, e^{-k_3 (t - \text{wearH})}
  $$
  
- **一阶**：以 `k₁` 做“假库”吸收 + 口径 `F = 1`；移除时截断后续输入（实现上等价于减去佩戴结束后的继续吸收项）。

### 3.3 调参与选择
- 文献与说明书以 µg/day 标称，实际贴补图形更接近零阶，因此默认优先零阶，仅在缺乏数据时降级为一阶近似。

---

## 4) 经皮凝胶（E2）

> **2025 重写说明**：本节描述的是**当前**实现。早期文档中“单室一阶 + `baseK1 = 0.022`、`Fmax = 0.05`、忽略面积/剂量密度”的**临时常量版已被废弃**；现行模型是带产品注册表、部位/面积/洗涤效应的**三层经皮级联**。

### 4.1 模型结构（三层级联）
- **模型**：表面层 → 皮肤贮库 → 系统中心室的线性级联，闭式解。每次给药按一个表面贮库注入，逐层向系统室传递。
- **微分方程（单位 h⁻¹）**：

  $$
  \begin{aligned}
  \dot M_{s}    &= -(k_{\text{Pen}}+k_{\text{Loss}})\,M_{s}\\
  \dot M_{\text{skin}} &= k_{\text{Pen}}\,M_{s} - k_{\text{Rel}}\,M_{\text{skin}}\\
  \dot M_{c}    &= k_{\text{Rel}}\,M_{\text{skin}} - k_e\,M_{c}\quad(\text{返回中心室药量})
  \end{aligned}
  $$

- **速率常数的物理含义**：
  - **表面层快速清空**：$k_{\text{Pen}}+k_{\text{Loss}} = \lambda_s \approx 1.4\ \mathrm{h^{-1}}$（$t_{1/2}\approx 0.5\,$h，溶剂干燥、药物或渗入皮肤或经蒸发/转移/洗脱损失）。决定系统吸收分数的是这二者的**分配比**而非时间尺度：$F_{\text{ref}} = k_{\text{Pen}}/(k_{\text{Pen}}+k_{\text{Loss}})$。
  - **慢相由皮肤贮库释放**主导：$k_{\text{Rel}}\approx 0.022\ \mathrm{h^{-1}}$（$t_{1/2}\approx 31\,$h），对应涂抹后数小时到次日的平台与拖尾。
  - **系统清除** $k_e = $ `CorePK.kClear` $= 0.41\ \mathrm{h^{-1}}$（与其他游离 E2 路由一致）。
- **代码入口**：`gelEventCentralAmount(...)` → `resolveGelKinetics(...)` 解析速率常数 → `gel3CompCentralAmount(...)`（`pk.ts`）。速率常数在**模拟时**根据事件存储的 `产品 id + 部位 + 面积 + washAfterH` 解析，事件本身只存这些引用——因此编辑一个自定义产品会即时联动其全部历史记录。

### 4.2 产品注册表（`GEL_PRODUCTS`）
每个凝胶产品是注册表中的一条记录，同时驱动 PK 引擎与录入 UI；新增凝胶只需注册一条，用户也可保存遵循同一结构的自定义产品（id ≥ `GEL_CUSTOM_ID_BASE = 1000`，经 `sanitizeGelProduct` 校验：仅三个速率常数 `kPenBase/kLoss/kRel` 不可缺省，缺失的元数据给安全默认）。

| 预置产品 | 浓度 mg·mL⁻¹ | 默认面积 cm² | 参考剂量 mg | kPenBase | kLoss | kRel |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Oestrogel / Estrogel | 0.6 | 750 | 1.5 | 0.140 | 1.260 | 0.022 |
| Estreva | 1.0 | 400 | 1.5 | 0.154 | 1.246 | 0.022 |
| Divigel | 1.0 | 200 | 1.0 | 0.168 | 1.232 | 0.024 |
| DIY（自配） | 1.0 | 400 | 2.0 | 0.112 | 1.288 | 0.022 |

字段关系：`kPenBase = F_ref·λ_s`，`kLoss = (1−F_ref)·λ_s`（`λ_s = LAMBDA_SURFACE = 1.4`）。默认面积/参考剂量与官方标签的推荐部位/面积方向一致（Divigel 上大腿约 200 cm²；Oestrogel 类至少约 750 cm²）。

### 4.3 部位因子（`GEL_SITE_FACTORS`）
作用在 `kPenBase` 上的相对渗透倍率：`arm = 1.0`、`thigh = 1.0`、`abdomen = 1.1`、`scrotal = 8.0`。

> ⚠️ **scrotal = 8× 是低证据等级的研究模式先验**，从阴囊**睾酮**研究外推，并非雌二醇凝胶的验证值；UI 中应作为研究/高级选项呈现并附高不确定性提示，不作为普通推荐入口。

> **阴囊的面积处理(genital skin)**：生殖器皮肤渗透性较高(研究先验),且阴囊涂抹面积无法可靠测量、证据有限。因此对 `scrotal`,§4.4 的角质层剂量密度修正**不适用**,被**置 1(中性化)**,吸收由 8× 部位因子刻画 —— 估测**不随涂抹面积变化**(`resolveGelKinetics` 中 `if (site === scrotal) densityFactor = 1`)。否则一个默认的 750 cm² 会把密度因子推向 2× 上限,与 8× 叠乘出虚假的高估。**注意**:这并不等于"吸收近乎完全"——吸收分数仍为 $k_{\text{Pen}}/(k_{\text{Pen}}+k_{\text{Loss}})$(Oestrogel 约 0.47),且 8× 本身是从睾酮外推的低证据先验。

### 4.4 面积 / 剂量密度 / 浓度耦合（`resolveGelKinetics`）
- **剂量密度修正**：以单位皮肤面积上的 E2 质量 $\sigma = \text{dose}/\text{area}$（mg·cm⁻²）为主驱动（Maturitas：同一面积上的 E2 量是吸收的主要决定因素）。

  $$
  \text{densityFactor} = \frac{1 + \sigma_{\text{ref}}/\sigma_{\text{sat}}}{1 + \sigma/\sigma_{\text{sat}}},\qquad
  k_{\text{Pen}} = k_{\text{PenBase}}\cdot r_{\text{site}}\cdot \text{densityFactor}
  $$

  其中 $\sigma_{\text{ref}}=\text{refDose}/\text{defaultArea}$，故在产品参考密度处 `densityFactor = 1`、$F_{\text{ref}}$ 被保留；factor 被裁剪在 `[0.5, 2.0]`。摊薄（更大面积 / 更低剂量）→ σ 下降 → factor 上升 → 吸收分数升高；反之降低。
- **浓度作为显式动力学变量**：半饱和点随凝胶强度缩放 $\sigma_{\text{sat}}(c) = \texttt{GEL\_SIGMA\_SAT}\cdot c/\texttt{GEL\_CONC\_REF}$（`GEL_SIGMA_SAT = 0.008`，`GEL_CONC_REF = 1.0`）。物理直觉：同样的 E2 质量装在更浓的凝胶里，成膜更薄、药物更密，在更高的面载量处才饱和皮肤分配。该项是**结构性群体先验，待 IVPT 标定**，并非拟合值；它**只在偏离参考密度时起作用**（参考剂量处 factor 恒为 1，故默认剂量预测与浓度无关）。`concentrationMGmL` 此前仅作为产品标签、不参与动力学，本次起正式入模。
- **洗涤 / 摩擦（`washAfterH`）**：在该时刻移除残余表面膜（洗掉 / 蹭掉），仅 $[0,\text{washAfterH}]$ 区间的表面贮存继续向系统贡献，按两段解求。

### 4.5 用户输入：涂抹范围模板与同用外用品
为方便用户(普通用户并不知道自己涂了多少 cm²),涂抹面积从"必填裸数字"降级为**后台推导变量**:

- **涂抹范围模板(`GEL_COVERAGE_TEMPLATES`)**:用户选择一个可识别的覆盖范围,系统反推面积(cm²)写入 `areaCM2`,PK 引擎不变。
  - `product`:按说明书标准薄涂 → 产品默认面积(如 Oestrogel 750、Divigel 200)。
  - `palm1/2/3`:约 1/2/3 个手掌,采用手掌法(`GEL_PALM_AREA_CM2 ≈ 175 cm²/掌`,约 1% 体表面积,随体型自缩放)。
  - `thigh`(单侧大腿前侧 ≈200 cm²,对标 Divigel)、`arm`(单侧手臂腕到肩 ≈750 cm²,对标 EstroGel/Oestrogel)、`arms2`(双侧手臂 ≈1500 cm²)。
  - `manual`:手动输入 cm²(高级/兜底;旧记录无模板标记时按此显示其原始 cm²,数值不变)。
  - 解析函数 `resolveGelCoverageArea(idx, product, manualCM2)`。模板索引另存于 `ExtraKey.gelCoverage`(仅用于表单回显);引擎仍只读 `areaCM2`。这些是**粗粒度群体先验**,受体型影响,故始终保留手动入口。
- **同用外用品(`GEL_COAPPLICATION_*`)**:在凝胶之上叠涂的外用品会实质改变暴露。EstroGel 标签:给药后 1 h 每日叠涂**防晒**使 AUC0–24 ↓≈16%、**保湿乳**使其 ↑≈38%(Cmax ↑≈73%)。建模为对系统吸收量的**乘性因子**(`none=1.0 / sunscreen=0.84 / moisturizer=1.38`,见 `gelCoApplicationFactor`),在 `gelEventCentralAmount` 中对中心室药量整体缩放(线性级联 ⇒ 等价于缩放有效剂量),因此 AUC 与 Cmax 同比缩放、tmax 不变。我们只刻画**暴露(AUC)**效应,不单独建模保湿乳更大的 Cmax 形变(证据较弱、需重塑 kPen)。存于 `ExtraKey.gelCoApplied`(0/缺省=无)。

### 4.6 校准锚点
先验常数被调到大致复现：单剂 $t_{\max}\approx 8\,$h（接受 4–16 h 区间）、给药后 1 h 清洗的暴露保留 $\approx 0.75$（标签：EstroGel −22%、Divigel −30%）、以及 $F_{\text{ref}} = k_{\text{Pen}}/(k_{\text{Pen}}+k_{\text{Loss}})$ 的质量守恒。这些都由 `pk.test.ts` 的单元测试守护。

### 4.7 已知局限与后续方向
- 当前面积—厚度—蒸发—转移耦合仍以单一软饱和函数近似，未做显式质量守恒的有限剂量蒸发建模。
- 涂抹范围模板与手掌法面积是**粗粒度群体先验**，受体型影响；更精确的体表面积需身高/体重/BSA 或图像估计（图像方案须端侧处理以保隐私，属后续 UX，非本模块计算逻辑）。
- 同用外用品因子取自 EstroGel 标签，作为跨产品的一般化先验;只刻画 AUC 暴露效应,未分别建模 Cmax 形变。
- 长期方向：半机制质量守恒模型 + 分层混合效应 / 贝叶斯个体化（需 IVPT 与人群 PK 数据，超出当前实现范围）。

---

## 5) 口服（E2/EV）

### 5.1 模型与参数
- **模型**：单室 Bateman 吸收–清除。**EV 的水解效应已折叠进更小的 `kAbsEV`，不单独建 `k₂`。**
- **默认参数**：  
  `kAbsE2 = 0.08 h⁻¹`（E2 片，`Tmax ≈ 2–3 h`）。  
  `kAbsEV = 0.05 h⁻¹`（EV 片，`Tmax ≈ 6–7 h`）。  
  `bioavailability = 0.03`（口服首过后系统暴露，E2 与 EV 近似相同量级）。  

### 5.2 调参说明
- `F = 0.03` 体现了口服首过代谢的强烈损耗；与常见文献 2–5% 的数量级一致。
- `kAbs` 调整使曲线在 2–7 小时区间达到合理峰位。

---

## 6) 舌下（E2/EV）

### 6.1 模型与参数（路线图）
- **双通路**：把剂量按分流系数 **θ** 分为两支：
  - **快通路（口腔黏膜）**：$k_{1,\text{fast}} = k_{\text{SL}}$，**绕过首过**。本项目统一按**等效 E2(E2‑eq)**输入，因此快支 **$F_{\text{fast}}=1$**。
  - **慢通路（吞咽→胃肠）**：$k_{1,\text{slow}} = k_{\text{Abs,E2/EV}}$，**进入首过**，**$F_{\text{slow}}=F_{\text{oral}}=0.03$**。
- **EV 与 E2 的差异**：
  - **舌下 E2**：无水解步（$k_2=0$），用单室 Bateman 对两支路叠加（`dualAbsAmount`）。
  - **舌下 EV**：**进血后仍需水解为 E2**（$k_2=k_{2,\text{EV}}$），两支路均走「吸收 ($k_1$) → 水解 ($k_2$) → 清除 ($k_3$)」的三室解析式（`dualAbs3CAmount`）。
  - **清除**：中心室游离 E2 的清除常数 $k_3 = 0.41\ \mathrm{h}^{-1}$（见§1），与贴片移除后回落节奏一致。

### 6.2 黏膜分流 θ 的**行为建模**（取代早期 RF 反推法）
早期文档用 $\theta=\frac{F_{\text{oral}}(RF-1)}{1-F_{\text{oral}}}$ 从相对生物利用度 RF 反推 θ。该做法只能匹配 **AUC 比例**，会误估 **峰值/达峰时间**，因此已弃用。

我们显式建模**溶解**与**吞咽清除**，把口腔当作最小可用系统：
- 固体剂量 ($S$) 以速率 $k_{\text{diss}}$ 溶到口腔液相 \(D\)；
- 溶解相 ($D$) 面临两个竞争路径：**黏膜吸收** $(k_{\text{SL}})$ 与**吞咽清除** $(k_{\text{sw}})$。

连立常微分方程（单位 h）：
$$
\begin{aligned}
\frac{dS}{dt}&=-k_{\text{diss}}\,S\\
\frac{dD}{dt}&=k_{\text{diss}}\,S-(k_{\text{SL}}+k_{\text{sw}})\,D
\end{aligned}
$$

在用户的“含服窗口” $T_{\text{hold}}$ 内，**真正走黏膜**的比例定义为
$$
\boxed{\ \theta(T_{\text{hold}})=\frac{1}{\text{Dose}}\int_{0}^{T_{\text{hold}}} k_{\text{SL}}\,D(t)\,dt\ }
$$
超过 $T_{\text{hold}}$ 的残留（未吸收固体与溶解相）一律视为吞咽，进入口服通道（即我们的**慢支**）。

**参数锚点与合理区间**
- $k_{\text{SL}}$ 以**实测达峰**锚定：舌下 E2 常见 $T_{\max}\approx 1\ \mathrm{h}$。一室解析
  $T_{\max}=\frac{\ln(k_a/k_e)}{k_a-k_e}$，代入 $k_e=k_3=0.41\ \mathrm{h}^{-1}$ 反推 $k_a\approx 1.8\text{–}2.0\ \mathrm{h}^{-1}$。本项目取 **$k_{\text{SL}}=1.8\ \mathrm{h}^{-1}$**。
- $k_{\text{diss}}$：口腔制剂溶解/崩解的**分钟级**过程，经验半衰期选 **3/5/10 min** 三档（速崩/常规/偏慢），便于随配方微调。
- $k_{\text{sw}}$：**有效**唾液清除率（非吞咽频次），经验区间 **0.8 / 1.8 / 3.0 h⁻¹** 代表低/中/高个体差异，后续可用外部数据回归精化。

**计算实现**
- App 内对上式做**数值积分**（固定步长 Δt≈3.6 s 的 Euler），得到 $\theta(T_{\text{hold}})$。
- 为便于直观理解，我们也提供一个保守的闭式近似（作为上界/直觉，不用于核心计算）：

$$
\theta_{\text{eff}}\ \approx\ \frac{k_{\text{SL}}}{k_{\text{SL}}+k_{\text{sw}}}\Bigl(1-e^{-(k_{\text{SL}}+k_{\text{sw}})T_{\text{hold}}}\Bigr)\Bigl(1-e^{-k_{\text{diss}}T_{\text{hold}}}\Bigr)
$$

**UI 档位（不再使用 `theta_default`，用户必须选择一档）**  
采用中档场景（$k_{\text{sw}}=1.8\ \mathrm{h}^{-1}$，溶解半衰期 5 min）计算，并给出跨场景范围作参考：

| 档位 | 建议含服时长 | θ 推荐 | 典型范围（跨不同 $k_{\text{sw}}$/$k_{\text{diss}}$） |
| --- | ---: | ---: | ---: |
| Quick | ≈ 2 min | **0.01** | 0.004–0.012 |
| Casual | ≈ 5 min | **0.04** | 0.021–0.057 |
| Standard | ≈ 10 min | **0.11** | 0.064–0.156 |
| Strict | ≈ 15 min | **0.18** | 0.115–0.253 |

- UI 选择的档位直接映射为 \(\theta\) 并写入 `DoseEvent.extras[.sublingualTheta]`；**不再读取/依赖 `theta_default`**。

**一致性校验（慢支=口服）**  
当 $\theta=0$ 时，舌下模型**严格退化为口服**：慢支的 $k_{1,\text{slow}}$、$F_{\text{slow}}$、$k_2$、$k_3$ 与对应口服路由完全一致。在回归测试中对比了 “SL，$\theta=0$” 与 “Oral” 的整轨迹，差异 0。

### 6.3 数学形式（实现对照）
- **舌下 E2（无水解）**：两支路的一室 Bateman 叠加  
  $$
  A(t)=A_{\text{fast}}(t)+A_{\text{slow}}(t),\quad
  A_{\text{branch}}(t)=\frac{F\,k_1}{k_1-k_3}\,\text{Dose}_{\text{branch}}\bigl(e^{-k_3 t}-e^{-k_1 t}\bigr)
  $$
- **舌下 EV（含水解）**：两支路的三室解析叠加  
  $$
  A(t)=A^{(3C)}_{\text{fast}}(t)+A^{(3C)}_{\text{slow}}(t),\quad
  A^{(3C)}_{\text{branch}}(t)=\texttt{\_analytic3C}\bigl(t;\ \text{Dose}_{\text{branch}},F,k_1,k_{2,\text{EV}},k_3\bigr)
  $$
  其中 $\text{Dose}_{\text{fast}}=\theta\cdot\text{Dose},\ \text{Dose}_{\text{slow}}=(1-\theta)\cdot\text{Dose}$，且 $F_{\text{fast}}=1,\ F_{\text{slow}}=F_{\text{oral}}$。

---

## 6A) 螺内酯（SPL，抗雄）

- 螺内酯本体 t½ ≈ 1.4 h，持续活性来自活性代谢物**坎利酮**，因此追踪坎利酮浓度（ng/mL）。
- 表观一室：`ka = 0.60 h⁻¹`（吸收 + 代谢生成合并），`ke = ln2/16.5 h⁻¹`，`V/F = 737 L`（以螺内酯 mg 计，转化分数并入 V/F）。
- 校准锚点（Aldactone 说明书，100 mg/日 × 15 天）：坎利酮 Cmax ≈ 181 ng/mL、Tmax ≈ 4.3 h、t½ ≈ 16.5 h。模型稳态 Cmax ≈ 181 ng/mL、Tmax ≈ 4 h。
- 与 BICA 相同：仅群体曲线 + 群体 PK 不确定区间（`popLogVar = 0.12`），不并入总浓度曲线，不接入个体化学习。实现见 `pk.ts :: SPL_PK / computeSpironolactoneAmount`。

## 6B) 内源性睾酮抑制模型（影响内源性 E2）

**动机**：未治疗时约 20–30 pg/mL 的 E2 主要由睾酮芳香化而来。旧版把用药前基线当作**常数**加在曲线上，并在 EKF/OU/MIPD 中按常数扣除；但 HRT 会抑制 LH/睾酮，芳香化来源的 E2 随之下降。常数基线会高估受抑制者的 E2，并把偏差误归给 PK 参数（θ 被压低）。

**结构**（间接反应模型，`pk.ts :: TESTOSTERONE_MODEL`）：

```
T_target(t) = T0 · (1 − I_E2) · (1 − I_CPA) · (1 − I_SPL) · (1 + S_BICA)
dT/dt       = kout · (T_target − T),   kout = ln2 / 48 h
I = Imax·Cⁿ/(IC50ⁿ + Cⁿ)
```

| 效应 | 浓度 | Imax / Smax | IC50 / EC50 | n |
|---|---|---|---|---|
| E2 负反馈 | 药物 E2 (pg/mL) | 0.97 | 130 | 3 |
| CPA | ng/mL | 0.90 | 5 | 1 |
| 螺内酯（坎利酮） | ng/mL | 0.40 | 100 | 1 |
| 比卡鲁胺（升高 LH/T） | ng/mL | +0.60 | 3000 | 1 |

- 锚点：E2 单药 ≈100 pg/mL → T ≈ 350 ng/dL；≈200 → ≈120；≥300 → <55。CPA 10–12.5 mg/日单药抑制约 70–80%；螺内酯仅轻度；比卡鲁胺单药使 T（及芳香化 E2）上升约 50%。
- 驱动浓度使用**群体药物 E2**（不含内源部分，避免反馈环），逐网格点用分段常数精确解积分，任意步长稳定。下限 `minFraction = 0.02`（肾上腺来源）。
- **内源性 E2(t) = B · T(t)/T0**。B 优先取用药前化验（若该化验时已受抗雄抑制，则以 obs / f(t) 还原）；无化验时用群体默认 25 pg/mL。
- 校准层统一通过 `EndogenousE2Context` / `resolveEndogenousE2` 扣除/加回时变内源部分：EKF（`ekfUpdatePersonalModel`）、OU-Kalman（`baselineAt`）、Hybrid-MIPD（`fitMipd`）。模型关闭时完全回退为旧版常数基线行为。
- **内源性 E2 结构（待验证假设）**：E2_endo(t) = B·(ρ·T(t)/T0 + 1 − ρ)。ρ（随 T 变动的比例）只作为 logit-normal 先验（中位数 0.75、logit SD 1.0），**不拟合**，只传递不确定性；1 − ρ 为不随 T 变动的残余基线。B 仅在有用药前 E2 检验时由资料估计（对数 SD 0.15），否则用族群先验 25 pg/mL（对数 SD 0.4）。因此资料稀疏时不会同时自由估计 B、ρ 与 T↔E2 转换关系。实现见 `pk.ts :: ENDOGENOUS_E2`。
- **以实测睾酮校准（t-gp-v2）**：log T_obs = log T0 + δ0 + log S(t; ηT) + a(t)·u(t) + ε。
  - δ0：个人 T0 偏移（先验 SD 0.35；用户手动输入时 0.15），用药前检验主要约束它，不影响 T/T0。
  - ηT：所有抑制/刺激效价乘以 exp(ηT) 的个人敏感度；先验 SD 0.5，**至少 2 笔用药后 T 检验才估计**（GP 边际似然 MAP + Laplace SD），否则固定为 0。
  - a(t)·u(t)：用药反应偏差，u 为 OU 过程（SD 0.8、相关长度 45 天），幅度 a(t) = min(1, |ln S_pop|/ln 2)，治疗前为 0（所以治疗前 T/T0 恒为 1、无不确定性）。
  - ε：检验噪声 SD 0.2。
- **资料截止（与 E2 共用）**：`causal`（当时预测）在每个时间点只以当时以前的检验做 GP 条件化（等同 Kalman 滤波），ηT 也按检验逐次重拟；`retrospective`（回顾校准）用全部检验（平滑）。T 与 E2 读取同一个 `calibrationMode`。验算：10 天后一笔 4 倍的 T 检验，在 causal 下今天的 T 不变（比值 1.000），在 retrospective 下约 ×3.0。
- **E2／T 共同估计（区块座标交替）**：`computeCoupledSimulationWithCI` 以个人化的药物 E2（与 E2 预测同一组个人参数）驱动 T 模型，再用新的内源性 E2 重跑 E2 校准，交替至 T 曲线变化 < 0.5%（最多 3 次）。E2 检验约束 E2 暴露；T 检验约束 ηT、残差与经由内源部分影响 E2 的扣除。T 检验刻意不重估 E2 暴露尺度：ηT 自由时两者无法由稀疏 T 资料分辨。中间迭代只以 2 小时步长计算个人化药物 E2，最后一次才做完整区间。
- **不确定性传递**：T 的后验变异（GP + ηT）、ρ 与 B 以同一批固定种子的后验样本（256 组，所有时间点共用）与药物 E2 的对数常态样本相加，区间取经验分位数；中心线 = 药物点估计 + 内源性后验平均。三种 E2 校准模型共用此步骤。
- 所有抑制参数、比卡鲁胺上升效应、45 天相关尺度与误差大小都是**待验证先验**；比卡鲁胺的 T 反应个体差异尤其大。
- 设定：「校准」页可开关（默认开启）并填写治疗前睾酮（ng/dL，仅影响睾酮显示数值，E2 只依赖比例 T/T0）。该设定只保存在本机，不随云同步。

## 7) AUC 计算与稳态
- **AUC**：在 `SimulationEngine` 中对已合成的浓度轨迹采用梯形法积分得到（单位 `pg·h/mL`）。
- **稳态**：模型为线性系统（在当前常数 `k₃` 设定下），重复给药时叠加自然收敛至稳态。注射两库与贴片零阶输入也保持线性可叠加性。
- **注意**：由于本项目对若干参数做了经验缩放使 `Cmax/Tmax` 更贴近观测，AUC 的绝对值在不同路由间比较时需谨慎，适合作为同一路由下的相对比较与个体内优化。

---

## 8) 探索历程（摘记）
以下按时间线回顾，方便未来溯源与复现。时间基于内部项目记录与代码注释。

- **2025‑06**：完成三室解析解（注射/口服/凝胶的公共内核），最初版本采用单库吸收。实现 AUC 计算与 pg/mL 输出。
- **2025‑07‑中**：  
  - 贴片新增零阶输入路径，UI 支持 `releaseRateUGPerDay`。未提供标称时继续启用一阶近似。  
  - 舌下路由从“含服时长”降维到固定双通路分流 θ，以减少用户面板的负担并稳定曲线。（此做法已在 2025‑09‑22 废弃，见下文）
- **2025‑07‑末**：注射改为两库模型（`TwoPartDepotPK`），分别用 `k1_fast` 与 `k1_slow` 控制峰与尾；为贴合真实暴露，`formationFraction` 引入经验放大因子并与 `toE2Factor` 相乘作为 `F`。
- **2025‑08‑初**：  
  - 尝试“浓度反馈清除”（早期 hill/抑制式 k），在多事件叠加时出现不稳定与过拟合风险，回退为常数 `k₃` 并在注释中保留方案。  
  - 凝胶在进行“剂量/面积”非线性修正时出现系统性偏差（低剂量低估、高剂量高估），临时回退为 `(k₁ = 0.045, F = 0.05)` 常量实现，并在代码旁保留 `sigmaSat` 等参数以待重启。
- **2025‑08‑中**：统一由 `ParameterResolver` 把各路由映射到 `PKParams`，`SimulationEngine` 以事件窗口裁剪贴片贡献（`patchApply → patchRemove`），AUC 梯形法稳定。
- **2025‑09‑03**：  
  - 为注射路径加入 `CorePK.kClearInjection = 0.05 h⁻¹`，并在 `ParameterResolver` 中按路由切换 `k3`。  
  - 重新标定注射两库参数：`Frac_fast`、`k1_fast`、`k1_slow`（详见 2.2 表），以复现 EV ≈ 2.1 d、EC ≈ 4 d、EN ≈ 6.5 d 的单剂达峰与稳态形状。  
  - 更新 `InjectionPK.formationFraction` 为分酯别经验值（见 2.3），并在 README 中明确其“有效参数”属性与适用范围。
- **2025‑09‑22**：
  - 舌下：**废弃 RF→θ 的反推与固定 θ**；引入**行为驱动**的 θ 计算（显式建模溶解 $k_{\text{diss}}$ 与吞咽清除 $k_{\text{sw}}$），按 $T_{\text{hold}}$ 数值积分得到 \(\theta\)。
  - UI：移除 `theta_default`，改为**四档可选**（Quick/Casual/Standard/Strict），默认显示建议含服时长与推荐 θ。
  - 舌下 EV：两支路均加入水解 \(k_2\)，实现切换为 `dualAbs3CAmount`；舌下 E2 继续用 `dualAbsAmount`。
  - 一致性单元测试：验证 $\theta=0$ 时舌下与口服整轨迹重合（慢支参数与 Oral 路由完全一致）。
- **凝胶重写（替代临时常量版）**：
  - 凝胶从“单室一阶 + `baseK1=0.022`、`Fmax=0.05`、忽略面积/密度”的临时常量版，**重写为三层经皮级联**（表面 → 皮肤贮库 → 系统中心室，`gel3CompCentralAmount`），并引入产品注册表 `GEL_PRODUCTS` + 自定义产品、部位因子、剂量密度软饱和修正与 `washAfterH` 洗涤效应。先验对标 EstroGel/Divigel 的 $t_{\max}\approx 8\,$h 与 1 h 洗后暴露下降（见 §4）。
  - **浓度入模**：`concentrationMGmL` 此前仅作产品标签、不参与动力学。现令剂量密度半饱和点随凝胶强度缩放 $\sigma_{\text{sat}}(c)=\texttt{GEL\_SIGMA\_SAT}\cdot c/\texttt{GEL\_CONC\_REF}$，使浓度成为显式动力学变量；该项为结构性先验、仅在偏离参考密度时起作用（参考剂量处 factor≡1，默认预测不变），待 IVPT 标定。
  - **文档同步**：本节（§0/§4/§10/§11/§12）由“临时常量版”更新为现行三层级联实现，消除文档—代码漂移。

---

## 9) 参考与依据（部分）
下列仅列出常用且与实现高度相关的部分参考，非详尽清单。

**社区与技术文档**
- mtf.wiki：雌二醇凝胶（含经皮半衰期、实用注意事项）<https://mtf.wiki/zh-cn/docs/medicine/estrogen/gel>
- Transfem Science（含注射曲线汇总、舌下综述、不同途径比较等）
- Injectable E2 meta-analysis（注射曲线的非正式荟萃）<https://transfemscience.org/articles/injectable-e2-meta-analysis/>
- Sublingual estradiol overview（舌下作为替代途径的综述）<https://transfemscience.org/articles/sublingual-e2-transfem/>
- Approximate comparable doses（不同途径的近似等效剂量）<https://transfemscience.org/articles/e2-equivalent-doses/>
- Oral vs transdermal estradiol（口服与透皮比较）<https://transfemscience.org/articles/oral-vs-transdermal-e2/>
- estrannai.se：对于Injection的三室模型和Patch的相关算法参考<https://estrannai.se/docs/ingredients/>

**官方说明书/监管资料**
- Climara®（Bayer）说明书：移除贴片后约 12 h 回落至基线，表观半衰期约 4 h（FDA 标签）<https://www.accessdata.fda.gov/drugsatfda_docs/label/2001/20375s16lbl.pdf>
- FDA NDA 临床药理综述与产品手册：透皮相对口服的生物利用度、部位差异、周内曲线稳定性等（多份，示例）  
  <https://www.accessdata.fda.gov/drugsatfda_docs/nda/99/020994_clinphrmr.pdf>  
  <https://www.accessdata.fda.gov/drugsatfda_docs/label/2008/020375s026lbl.pdf>

**期刊/综述（示例）**
- Ginsburg ES et al. Half-life of estradiol in postmenopausal women. Fertil Steril. 1998：贴片移除后终末半衰期约 161 min（107–221 min）。<https://pubmed.ncbi.nlm.nih.gov/9473164/>
- Kuhl H. Pharmacology of estrogens and progestogens: influence of different routes of administration. *Climacteric*. 2005. <https://pubmed.ncbi.nlm.nih.gov/16112947/>
- Oinonen et al. Absorption and bioavailability of oestradiol from a gel, a patch and a tablet. *Eur J Pharm Biopharm*. 1999. <https://pubmed.ncbi.nlm.nih.gov/10465378/>
- 比较矩阵与储库型贴片的生物利用度与速率差异的研究（如 Menorest® vs Estraderm®）。

**百科与药学数据库**
- Wikipedia: Pharmacokinetics of estradiol（路由差异、凝胶 36 h 表观半衰期等聚合条目）<https://en.wikipedia.org/wiki/Pharmacokinetics_of_estradiol>
- DrugBank: Estradiol（透皮生物利用度对比口服、部位差异）<https://go.drugbank.com/drugs/DB00783>

> 说明：实现中还参考了多份品牌说明书与审评文档、二级综述与数据手册，此处不一一列举。

---

## 10) 局限
- 个体差异未建模：肝功能、SHBG、年龄、体脂、并用药等可能改变 `F` 与各速率常数。
- 凝胶的面积/负荷非线性：已通过部位因子 + 浓度感知的剂量密度软饱和项（`resolveGelKinetics`）部分体现，但仍是单层近似——尚未做显式质量守恒的有限剂量蒸发建模。防晒/保湿等外用品**仅以 AUC 标量近似建模**（见 §4.5），未刻画其 Cmax 形变/时程。
- 注射溶剂/体积影响：对扩散 `k₁` 的影响尚未显式参数化，现仅可用全局系数 `depotK1Corr` 近似。
- 口服/舌下仅建模游离 E2：雌酮及其硫酸酯的储库效应未纳入。
- AUC 的跨路由可比性有限：参数含经验缩放，AUC 适合于相同路由内的相对比较与个体内优化。

---

## 11) 快速对照：各路由实现要点

| 路由 | 解析/数值 | 输入 | 模型 | 关键参数 | F 的来源 |
| --- | --- | --- | --- | --- | --- |
| 注射（油剂 EB/EV/EC/EN） | 解析 | mg | 两库吸收 + k₂ 水解 + k₃ 清除 | `Frac_fast, k1_fast, k1_slow, k2, k3 (= kClearInjection)` | `formationFraction` |
| 贴片（零阶） | 解析 | µg/day → mg/h | 零阶恒速输入 + k₃ 清除；移除后指数衰减 | `rateMGh, k3` | 固定 1.0 |
| 贴片（一阶遗留） | 解析 | mg | 一阶“假库” + k₃ 清除；移除时截断 | `k1, k3` | 固定 1.0 |
| 凝胶 | 解析 | mg（+产品 id/部位/面积 cm²/washAfterH） | 三层级联：表面 → 皮肤贮库 → 系统中心室 | `kPen, kLoss, kRel(产品), r_site, σ 密度修正, k3` | `kPen/(kPen+kLoss)`（按部位/面积/浓度解析） |
| 口服 E2 | 解析 | mg | 单室 Bateman | `kAbsE2 = 0.08, F = 0.03, k3` | 常量 0.03 |
| 口服 EV | 解析 | mg | 单室 Bateman | `kAbsEV = 0.05, F = 0.03, k3` | 常量 0.03 |
| 舌下 E2/EV | 解析 | mg（等效 E2） | 双通路：快 = 黏膜、慢 = 吞咽→口服；**E2 用一室（dualAbsAmount），EV 用三室（dualAbs3CAmount）** | `θ` 来自 UI 档位（Quick/5/10/15 分钟映射）；`kAbsSL=1.8`，`kAbsE2/EV`，`k2(EV)`，`k3` | 快 1.0；慢 `F_oral=0.03` |

---

## 12) 实现细节摘抄
- **PrecomputedEventModel**：
  - 注射：`injAmount(tau, dose, p)`
  - 口服：`oneCompAmount(tau, dose, p)`（把 `k1_fast` 视作该路由的 `ka`）
  - 凝胶：`gelEventCentralAmount(event, tau, ke)` → `resolveGelKinetics(...)` → `gel3CompCentralAmount(...)`（表面→贮库→中心室三层级联；`washAfterH` 两段解；产品按 id 在模拟时解析）
  - 舌下：`dualAbsAmount(tau, dose, p)`（`Frac_fast = θ`，`F_fast` 与 `F_slow` 可分配）
- **贴片**：
  - 找到紧随的 `patchRemove` 决定 `wearH`。
  - 零阶：佩戴内 `rateMGh/k3 × (1 − e^{−k3 t})`；移除后按 `e^{−k3 Δt}` 衰减。
  - 一阶：用 `oneCompAmount` 计算佩戴内吸收；移除后把“如果继续吸收”的部分减掉，使吸收在 `wearH` 处截断。
- **SimulationEngine**：
  - 时间网格均匀划分，逐点累加各事件药量 → 换算 pg/mL。
  - **AUC**：梯形法累计。
