(function () {

    // AE 标注批量生成器｜智能模板识别 v2.3
    // 基于 v8.2.3 最终校准逻辑


    if (!app.project) {
        alert("当前没有打开 AE 工程。");
        return;
    }

    var TEXT_LAYER_NAME = "标注"; // 仅保留兼容；v1.1 已不再强制固定文字层名
    var TEMPLATE_ALPHA = "ProRes4444XQ_Alpha";
    var TEMPLATE_422   = "ProRes422HQ";

    var DEFAULT_EXPAND_WIDTH  = 3000;
    var DEFAULT_EXPAND_HEIGHT = 300;
    var DEFAULT_SAMPLE_TIME   = 3.0;
    var DEFAULT_EXPORT_TIME   = 10.0;

    var batch = {
        exportComp: null,
        labelMaster: null,
        masterUsageLayer: null,
        textLayerName: null,
        textLayerIndex: 0,
        adapterConfig: null,
        referenceComp: null,
        referenceLayer: null,
        texts: [],
        labelCopies: [],
        placedLayers: [],
        textDone: false,
        cropDone: false,
        placeDone: false,
        exportDone: false
    };

    function trimText(s) {
        return String(s).replace(/^\s+/, "").replace(/\s+$/, "");
    }

    function safeFileName(text) {
        return String(text)
            .replace(/[\\\/:*?"<>|]/g, "_")
            .replace(/\s+/g, "_");
    }

    function collectAllComps() {
        var result = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) result.push(item);
        }
        return result;
    }

    function isTextLayerSafe(layer) {
        if (!layer) return false;

        try {
            if (layer.matchName === "ADBE Text Layer") {
                return true;
            }
        } catch (eMatch) {}

        try {
            var textProps =
                layer.property("ADBE Text Properties");

            if (!textProps) {
                return false;
            }

            var textDocument =
                textProps.property("ADBE Text Document");

            return textDocument !== null;

        } catch (e) {
            return false;
        }
    }

    function findTextLayer(comp, layerName, layerIndex) {
        if (!comp) return null;

        // 第一优先：按图层索引锁定。
        // Duplicate Comp 会保留图层顺序，因此比名称更稳定。
        if (
            layerIndex &&
            layerIndex >= 1 &&
            layerIndex <= comp.numLayers
        ) {
            try {
                var indexedLayer =
                    comp.layer(layerIndex);

                if (
                    indexedLayer &&
                    isTextLayerSafe(indexedLayer)
                ) {
                    return indexedLayer;
                }
            } catch (eIndex) {}
        }

        // 第二优先：按名称精确匹配
        if (layerName) {
            for (
                var i = 1;
                i <= comp.numLayers;
                i++
            ) {
                var namedLayer =
                    comp.layer(i);

                try {
                    if (
                        namedLayer.name === layerName &&
                        isTextLayerSafe(namedLayer)
                    ) {
                        return namedLayer;
                    }
                } catch (eName) {}
            }
        }

        // 最后兜底：第一个文字层
        for (
            var j = 1;
            j <= comp.numLayers;
            j++
        ) {
            var layer =
                comp.layer(j);

            if (
                isTextLayerSafe(layer)
            ) {
                return layer;
            }
        }

        return null;
    }

    function collectTextLayers(comp) {
        var result = [];

        if (!comp) {
            return result;
        }

        for (
            var i = 1;
            i <= comp.numLayers;
            i++
        ) {
            var layer =
                comp.layer(i);

            if (
                isTextLayerSafe(layer)
            ) {
                result.push(layer);
            }
        }

        return result;
    }

    function collectLabelComps() {
        return collectAllComps();
    }

    function getDropdownComp(dropdown, list) {
        if (!dropdown.selection) return null;
        var index = dropdown.selection.index;
        if (index < 0 || index >= list.length) return null;
        return list[index];
    }


    // ============================================================
    // 动态刷新：导出合成 + 标题模板 + 目标文字图层
    // ============================================================

    function findCompIndex(list, targetComp) {
        if (!targetComp) return -1;

        for (var i = 0; i < list.length; i++) {
            if (list[i] === targetComp) {
                return i;
            }
        }

        for (var j = 0; j < list.length; j++) {
            try {
                if (list[j].name === targetComp.name) {
                    return j;
                }
            } catch (e) {}
        }

        return -1;
    }

    function refillCompDropdown(dropdown, list, preferredComp) {
        dropdown.removeAll();

        for (var i = 0; i < list.length; i++) {
            dropdown.add(
                "item",
                list[i].name
            );
        }

        if (dropdown.items.length === 0) {
            return;
        }

        var keepIndex =
            findCompIndex(
                list,
                preferredComp
            );

        dropdown.selection =
            keepIndex >= 0
            ? keepIndex
            : 0;
    }

    function refreshTextLayerDropdown(preferredName) {
        textLayerDropdown.removeAll();

        var templateComp =
            getDropdownComp(
                labelDropdown,
                labelComps
            );

        if (!templateComp) {
            return;
        }

        var textLayers =
            collectTextLayers(
                templateComp
            );

        var preferredIndex = -1;

        for (var i = 0; i < textLayers.length; i++) {
            var textItem =
                textLayerDropdown.add(
                    "item",
                    textLayers[i].name
                );

            textItem.layerIndex =
                textLayers[i].index;

            if (
                preferredName &&
                textLayers[i].name === preferredName
            ) {
                preferredIndex = i;
            }
        }

        if (textLayerDropdown.items.length > 0) {
            textLayerDropdown.selection =
                preferredIndex >= 0
                ? preferredIndex
                : 0;
        }
    }



    function modeNameFromIndex(index) {
        var names = [
            "不处理",
            "水平拉伸",
            "矩形固定留白",
            "跟随文字右边缘",
            "跟随文字左边缘",
            "始终水平居中",
            "保持不动",
            "路径横向延展"
        ];

        return (
            index >= 0 &&
            index < names.length
        )
        ? names[index]
        : "未知";
    }

    function getLayerRotationAtTime(layer, sampleTime) {
        if (!layer) return 0;

        try {
            var rot =
                layer
                .property("ADBE Transform Group")
                .property("ADBE Rotate Z");

            if (!rot) {
                return 0;
            }

            return rot.valueAtTime(
                sampleTime,
                false
            );

        } catch (e) {
            return 0;
        }
    }

    function normalizeRotationDegrees(deg) {
        var v = deg % 360;

        if (v < 0) {
            v += 360;
        }

        return v;
    }

    function isNearHorizontalRotation(deg) {
        var v =
            normalizeRotationDegrees(
                deg
            );

        var tolerance = 12;

        return (
            v <= tolerance ||
            v >= 360 - tolerance ||
            Math.abs(v - 180) <= tolerance
        );
    }

    function propertyHasEnabledExpression(prop) {
        if (!prop) return false;

        try {
            return (
                prop.canSetExpression &&
                prop.expressionEnabled
            );
        } catch (e) {
            return false;
        }
    }

    function layerScaleHasExpression(layer) {
        if (!layer) return false;

        try {
            var scaleProp =
                layer
                .property("ADBE Transform Group")
                .property("ADBE Scale");

            return propertyHasEnabledExpression(
                scaleProp
            );

        } catch (e) {
            return false;
        }
    }

    function inferLayerRule(
        comp,
        layer,
        textLayer,
        textBounds,
        sampleTime
    ) {
        if (
            !layer ||
            layer === textLayer ||
            isTextLayerSafe(layer) ||
            isNullLayerSafe(layer)
        ) {
            return 0;
        }

        var bounds =
            getLayerVisualBounds(
                comp,
                layer,
                sampleTime
            );

        if (!bounds) {
            return 0;
        }

        var textCenter =
            getBoundsCenterX(
                textBounds
            );

        var layerCenter =
            getBoundsCenterX(
                bounds
            );

        var centerDistance =
            Math.abs(
                layerCenter -
                textCenter
            );

        var isWide =
            bounds.width >=
            textBounds.width *
            0.65;

        var isSmall =
            bounds.width <=
            Math.max(
                100,
                textBounds.width *
                0.38
            );

        var nearCenter =
            centerDistance <=
            Math.max(
                70,
                textBounds.width *
                0.22
            );

        var dashed =
            hasDashedStroke(
                layer
            );

        var rectProp =
            findLargestRectSizeProp(
                layer,
                sampleTime
            );

        var pathProp =
            findLargestShapePathProp(
                layer,
                sampleTime
            );

        var rotation =
            getLayerRotationAtTime(
                layer,
                sampleTime
            );

        var horizontalRotation =
            isNearHorizontalRotation(
                rotation
            );

        // --------------------------------------------------------
        // 保护箭头 / 三角形 / 旋转装饰
        //
        // 水平拉伸实际修改的是“图层本地 X 轴”。
        // 如果图层本身旋转了 90°，Scale X 就会变成视觉上的纵向拉伸，
        // 这正是箭头被拉成一条长竖线的原因。
        //
        // 所以：只要不是接近 0° / 180°，
        // 智能识别绝不自动分配“水平拉伸 / 路径延展 / 矩形固定留白”。
        // --------------------------------------------------------
        if (!horizontalRotation) {
            if (
                isSmall &&
                nearCenter
            ) {
                return 5;
            }

            if (isSmall) {
                if (
                    layerCenter >
                    textCenter
                ) {
                    return 3;
                }

                return 4;
            }

            return 6;
        }

        // 虚线优先：不能用整层Scale，否则虚线本身会变形。
        if (dashed) {
            if (rectProp) {
                return 2;
            }

            if (pathProp) {
                return 7;
            }
        }

        // 规则矩形，且宽度覆盖文字主体。
        if (
            rectProp &&
            isWide
        ) {
            return 2;
        }

        // 大面积 Shape / 图片背景：水平拉伸。
        //
        // 只有当 Scale 本身已经有表达式时才不自动改 Scale，
        // 不再因为图层里“别的属性”有表达式就把整层冻结。
        if (isWide) {
            if (
                !layerScaleHasExpression(
                    layer
                )
            ) {
                return 1;
            }

            // Scale 已经由模板表达式接管时，不自动覆盖。
            return 6;
        }

        // 小装饰，位于标题中心附近：保持居中。
        if (
            isSmall &&
            nearCenter
        ) {
            return 5;
        }

        // 小装饰靠右/靠左：跟随对应边缘。
        if (isSmall) {
            if (
                layerCenter >
                textCenter
            ) {
                return 3;
            }

            return 4;
        }

        return 0;
    }

    function setDropdownToLayerIndex(
        dropdown,
        layerIndex
    ) {
        if (!dropdown) return;

        for (
            var i = 0;
            i < dropdown.items.length;
            i++
        ) {
            if (
                dropdown.items[i].layerIndex ===
                layerIndex
            ) {
                dropdown.selection = i;
                return;
            }
        }

        dropdown.selection = 0;
    }

    function smartAnalyzeCurrentTemplate(showAlert) {
        var templateComp =
            getDropdownComp(
                labelDropdown,
                labelComps
            );

        if (!templateComp) {
            if (showAlert) {
                alert(
                    "请先选择标题模板。"
                );
            }
            return;
        }

        if (!textLayerDropdown.selection) {
            if (showAlert) {
                alert(
                    "请先选择需要修改的文字图层。"
                );
            }
            return;
        }

        var textLayerName =
            textLayerDropdown.selection.text;

        var textLayerIndex =
            textLayerDropdown.selection.layerIndex || 0;

        var textLayer =
            findTextLayer(
                templateComp,
                textLayerName,
                textLayerIndex
            );

        if (!textLayer) {
            if (showAlert) {
                alert(
                    "找不到当前选择的文字图层：" +
                    textLayerName
                );
            }
            return;
        }

        var settings =
            getSettings();

        var sampleTime =
            Math.min(
                settings.sampleTime,
                templateComp.duration -
                templateComp.frameDuration
            );

        if (sampleTime < 0) {
            sampleTime = 0;
        }

        forceRefreshComp(
            templateComp,
            sampleTime
        );

        var textBounds =
            getLayerVisualBounds(
                templateComp,
                textLayer,
                sampleTime
            );

        if (!textBounds) {
            if (showAlert) {
                alert(
                    "无法读取目标文字边界。"
                );
            }
            return;
        }

        // 确保左侧图层列表已填充
        refreshAdapterLayerDropdowns();

        var candidates = [];
        var summary = [];

        for (
            var i = 1;
            i <= templateComp.numLayers;
            i++
        ) {
            var layer =
                templateComp.layer(i);

            if (
                layer === textLayer ||
                isTextLayerSafe(layer) ||
                isNullLayerSafe(layer)
            ) {
                continue;
            }

            var inferred =
                inferLayerRule(
                    templateComp,
                    layer,
                    textLayer,
                    textBounds,
                    sampleTime
                );

            if (inferred === 0) {
                continue;
            }

            candidates.push({
                layerIndex: i,
                layerName: layer.name,
                modeIndex: inferred
            });
        }

        // 最多6条，按AE时间线顺序。
        for (
            var r = 0;
            r < adapterRuleLayerDropdowns.length;
            r++
        ) {
            if (r < candidates.length) {
                setDropdownToLayerIndex(
                    adapterRuleLayerDropdowns[r],
                    candidates[r].layerIndex
                );

                adapterRuleModeDropdowns[r].selection =
                    candidates[r].modeIndex;

                summary.push(
                    candidates[r].layerName +
                    " → " +
                    modeNameFromIndex(
                        candidates[r].modeIndex
                    )
                );

            } else {
                adapterRuleLayerDropdowns[r].selection =
                    0;

                adapterRuleModeDropdowns[r].selection =
                    0;
            }
        }

        if (candidates.length > 0) {
            cbEnableAdapter.value =
                true;
        }

        if (
            typeof adapterAnalysisText !== "undefined" &&
            adapterAnalysisText
        ) {
            adapterAnalysisText.text =
                candidates.length > 0
                ? (
                    "已识别 " +
                    Math.min(
                        candidates.length,
                        adapterRuleLayerDropdowns.length
                    ) +
                    " 个相关元素"
                )
                : "未识别到需要自动适配的设计元素";
        }

        if (showAlert) {
            alert(
                candidates.length > 0
                ? (
                    "智能分析完成。\\n\\n" +
                    summary.join("\\n") +
                    "\\n\\n建议先只执行第①步检查结果；识别错误时可在右侧手动改规则。"
                )
                : (
                    "智能分析完成，但没有识别到需要自动适配的设计元素。\\n\\n" +
                    "可以继续使用手动规则作为兜底。"
                )
            );
        }
    }

    function refreshAdapterLayerDropdowns() {
        if (
            typeof adapterRuleLayerDropdowns === "undefined" ||
            !adapterRuleLayerDropdowns
        ) {
            return;
        }

        var templateComp =
            getDropdownComp(
                labelDropdown,
                labelComps
            );

        var currentTemplateName =
            templateComp
            ? templateComp.name
            : null;

        var sameTemplate =
            (
                adapterLastTemplateName !== null &&
                adapterLastTemplateName === currentTemplateName
            );

        // 先记住同一模板当前右侧规则
        var savedModes = [];

        for (
            var m = 0;
            m < adapterRuleModeDropdowns.length;
            m++
        ) {
            var modeValue = 0;

            try {
                modeValue =
                    (
                        sameTemplate &&
                        adapterRuleModeDropdowns[m].selection
                    )
                    ? adapterRuleModeDropdowns[m].selection.index
                    : 0;
            } catch (eMode) {}

            savedModes.push(
                modeValue
            );
        }

        // --------------------------------------------------------
        // 左侧规则行：
        // 自动按照 AE 时间线图层顺序填充。
        //
        // 第1行 -> layer(1)
        // 第2行 -> layer(2)
        // ...
        //
        // 最多6层；不足6层的行显示“不使用”。
        // --------------------------------------------------------
        for (
            var d = 0;
            d < adapterRuleLayerDropdowns.length;
            d++
        ) {
            var dropdown =
                adapterRuleLayerDropdowns[d];

            dropdown.removeAll();

            var none =
                dropdown.add(
                    "item",
                    "不使用"
                );

            none.layerIndex = 0;

            if (templateComp) {
                for (
                    var i = 1;
                    i <= templateComp.numLayers;
                    i++
                ) {
                    var layer =
                        templateComp.layer(i);

                    var item =
                        dropdown.add(
                            "item",
                            i + "  " + layer.name
                        );

                    item.layerIndex =
                        i;
                }
            }

            // 自动选择和当前行号一致的 AE 图层
            // d=0 -> layer 1，所以 dropdown item index = 1
            var wantedLayerIndex =
                d + 1;

            var selectedItemIndex =
                0;

            if (
                templateComp &&
                wantedLayerIndex <= templateComp.numLayers
            ) {
                for (
                    var s = 0;
                    s < dropdown.items.length;
                    s++
                ) {
                    if (
                        dropdown.items[s].layerIndex ===
                        wantedLayerIndex
                    ) {
                        selectedItemIndex = s;
                        break;
                    }
                }
            }

            dropdown.selection =
                selectedItemIndex;
        }

        // --------------------------------------------------------
        // 右侧规则：
        // 同一模板刷新 -> 保留原选择
        // 切换新模板 -> 全部“不处理”
        // --------------------------------------------------------
        for (
            var r = 0;
            r < adapterRuleModeDropdowns.length;
            r++
        ) {
            var modeDropdown =
                adapterRuleModeDropdowns[r];

            var targetMode =
                sameTemplate
                ? savedModes[r]
                : 0;

            if (
                targetMode >= 0 &&
                targetMode < modeDropdown.items.length
            ) {
                modeDropdown.selection =
                    targetMode;
            } else {
                modeDropdown.selection =
                    0;
            }
        }

        adapterLastTemplateName =
            currentTemplateName;
    }

    function refreshCompDropdowns(showAlert) {
        var previousExport =
            getDropdownComp(
                exportDropdown,
                allComps
            );

        var previousLabel =
            getDropdownComp(
                labelDropdown,
                labelComps
            );

        var previousTextLayerName =
            textLayerDropdown.selection
            ? textLayerDropdown.selection.text
            : null;

        allComps =
            collectAllComps();

        labelComps =
            collectAllComps();

        refillCompDropdown(
            exportDropdown,
            allComps,
            previousExport
        );

        refillCompDropdown(
            labelDropdown,
            labelComps,
            previousLabel
        );

        refreshTextLayerDropdown(
            previousTextLayerName
        );

        refreshAdapterLayerDropdowns();

        if (showAlert) {
            alert(
                "列表已刷新。\\n\\n" +
                "导出合成：" +
                allComps.length +
                " 个\\n" +
                "标题模板：" +
                labelComps.length +
                " 个\\n\\n" +
                "标题模板现在可以从当前工程所有合成中自由选择。\\n" +
                "文字图层也可以单独选择。"
            );
        }
    }

    function setTextInComp(comp, text, layerName, layerIndex) {
        var layer =
            findTextLayer(
                comp,
                layerName,
                layerIndex
            );

        if (!layer) {
            throw new Error(
                "找不到需要修改的文字图层：" +
                layerName
            );
        }

        // 如果 Text Layer 还在使用 AE 的“随文字内容自动命名”，
        // 修改 Source Text 后 layer.name 可能一起变化。
        // 这里先把当前选中的名称写成显式图层名，后续引用更稳定。
        try {
            if (layerName) {
                layer.name = layerName;
            }
        } catch (eLockName) {}

        var textProp = layer
            .property("ADBE Text Properties")
            .property("ADBE Text Document");

        var doc = textProp.value;
        doc.text = text;
        textProp.setValue(doc);
    }


    // ============================================================
    // 模板适配器 v2.0
    //
    // 解决“新项目的标题模板没有自适应表达式”的问题。
    //
    // 支持：
    // 1. 背景水平缩放（适合笔刷、PNG、不规则 Shape）
    // 2. 矩形固定留白（适合 Rectangle Path）
    // 3. 装饰元素跟随右边缘移动
    //
    // 默认关闭，不影响已经稳定的旧模板。
    // ============================================================

    function escapeExpressionString(s) {
        return String(s)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');
    }

    function getLayerByIndexSafe(comp, index) {
        if (!comp || !index || index < 1 || index > comp.numLayers) {
            return null;
        }

        try {
            return comp.layer(index);
        } catch (e) {
            return null;
        }
    }

    function getLayerVisualBounds(comp, layer, sampleTime) {
        if (!comp || !layer) return null;

        try {
            var rect =
                layer.sourceRectAtTime(
                    sampleTime,
                    true
                );

            if (
                Math.abs(rect.width) < 0.001 &&
                Math.abs(rect.height) < 0.001
            ) {
                return null;
            }

            var pts = [
                layer.sourcePointToComp([rect.left, rect.top]),
                layer.sourcePointToComp([rect.left + rect.width, rect.top]),
                layer.sourcePointToComp([rect.left, rect.top + rect.height]),
                layer.sourcePointToComp([rect.left + rect.width, rect.top + rect.height])
            ];

            var minX = pts[0][0];
            var maxX = pts[0][0];
            var minY = pts[0][1];
            var maxY = pts[0][1];

            for (var i = 1; i < pts.length; i++) {
                minX = Math.min(minX, pts[i][0]);
                maxX = Math.max(maxX, pts[i][0]);
                minY = Math.min(minY, pts[i][1]);
                maxY = Math.max(maxY, pts[i][1]);
            }

            return {
                left: minX,
                right: maxX,
                top: minY,
                bottom: maxY,
                width: maxX - minX,
                height: maxY - minY
            };

        } catch (eBounds) {
            return null;
        }
    }

    function collectRectSizePropsInGroup(group, result) {
        if (!group) return;

        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);

            try {
                if (p.matchName === "ADBE Vector Rect Size") {
                    result.push(p);
                }
            } catch (e1) {}

            try {
                if (
                    p.propertyType === PropertyType.INDEXED_GROUP ||
                    p.propertyType === PropertyType.NAMED_GROUP
                ) {
                    collectRectSizePropsInGroup(
                        p,
                        result
                    );
                }
            } catch (e2) {}
        }
    }

    function findLargestRectSizeProp(layer, sampleTime) {
        if (!layer) return null;

        var candidates = [];

        try {
            collectRectSizePropsInGroup(
                layer,
                candidates
            );
        } catch (e) {}

        if (candidates.length === 0) {
            return null;
        }

        var best = null;
        var bestWidth = -1;

        for (var i = 0; i < candidates.length; i++) {
            try {
                var v =
                    candidates[i].valueAtTime(
                        sampleTime,
                        false
                    );

                if (
                    v &&
                    v.length >= 2 &&
                    v[0] > bestWidth
                ) {
                    bestWidth = v[0];
                    best = candidates[i];
                }
            } catch (eValue) {}
        }

        return best;
    }


    function collectShapePathPropsInGroup(group, result) {
        if (!group) return;

        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);

            try {
                if (p.matchName === "ADBE Vector Shape") {
                    result.push(p);
                }
            } catch (e1) {}

            try {
                if (
                    p.propertyType === PropertyType.INDEXED_GROUP ||
                    p.propertyType === PropertyType.NAMED_GROUP
                ) {
                    collectShapePathPropsInGroup(
                        p,
                        result
                    );
                }
            } catch (e2) {}
        }
    }

    function findLargestShapePathProp(layer, sampleTime) {
        if (!layer) return null;

        var props = [];
        collectShapePathPropsInGroup(
            layer,
            props
        );

        if (props.length === 0) {
            return null;
        }

        var best = null;
        var bestWidth = -1;

        for (var i = 0; i < props.length; i++) {
            try {
                var shape =
                    props[i].valueAtTime(
                        sampleTime,
                        false
                    );

                if (
                    !shape ||
                    !shape.vertices ||
                    shape.vertices.length === 0
                ) {
                    continue;
                }

                var minX = shape.vertices[0][0];
                var maxX = shape.vertices[0][0];

                for (
                    var v = 1;
                    v < shape.vertices.length;
                    v++
                ) {
                    minX = Math.min(
                        minX,
                        shape.vertices[v][0]
                    );

                    maxX = Math.max(
                        maxX,
                        shape.vertices[v][0]
                    );
                }

                var width =
                    maxX -
                    minX;

                if (width > bestWidth) {
                    bestWidth = width;
                    best = props[i];
                }

            } catch (ePath) {}
        }

        return best;
    }

    function groupHasDashProperties(group) {
        if (!group) return false;

        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);

            try {
                if (
                    p.matchName === "ADBE Vector Stroke Dashes" ||
                    p.matchName === "ADBE Vector Stroke Dash 1" ||
                    p.matchName === "ADBE Vector Stroke Gap 1"
                ) {
                    return true;
                }
            } catch (e1) {}

            try {
                if (
                    p.propertyType === PropertyType.INDEXED_GROUP ||
                    p.propertyType === PropertyType.NAMED_GROUP
                ) {
                    if (
                        groupHasDashProperties(
                            p
                        )
                    ) {
                        return true;
                    }
                }
            } catch (e2) {}
        }

        return false;
    }

    function hasDashedStroke(layer) {
        if (!layer) return false;

        try {
            return groupHasDashProperties(
                layer
            );
        } catch (e) {
            return false;
        }
    }

    function groupHasEnabledExpression(group) {
        if (!group) return false;

        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);

            try {
                if (
                    p.canSetExpression &&
                    p.expressionEnabled
                ) {
                    return true;
                }
            } catch (e1) {}

            try {
                if (
                    p.propertyType === PropertyType.INDEXED_GROUP ||
                    p.propertyType === PropertyType.NAMED_GROUP
                ) {
                    if (
                        groupHasEnabledExpression(
                            p
                        )
                    ) {
                        return true;
                    }
                }
            } catch (e2) {}
        }

        return false;
    }

    function stretchShapePathX(pathProp, ratio) {
        if (!pathProp) return;

        function scaledShape(shape) {
            if (
                !shape ||
                !shape.vertices ||
                shape.vertices.length === 0
            ) {
                return shape;
            }

            var out =
                new Shape();

            out.closed =
                shape.closed;

            var minX =
                shape.vertices[0][0];

            var maxX =
                shape.vertices[0][0];

            for (
                var i = 1;
                i < shape.vertices.length;
                i++
            ) {
                minX =
                    Math.min(
                        minX,
                        shape.vertices[i][0]
                    );

                maxX =
                    Math.max(
                        maxX,
                        shape.vertices[i][0]
                    );
            }

            var centerX =
                (minX + maxX) / 2;

            var verts = [];
            var inTs = [];
            var outTs = [];

            for (
                var v = 0;
                v < shape.vertices.length;
                v++
            ) {
                verts.push([
                    centerX +
                    (
                        shape.vertices[v][0] -
                        centerX
                    ) *
                    ratio,
                    shape.vertices[v][1]
                ]);

                inTs.push([
                    shape.inTangents[v][0] *
                    ratio,
                    shape.inTangents[v][1]
                ]);

                outTs.push([
                    shape.outTangents[v][0] *
                    ratio,
                    shape.outTangents[v][1]
                ]);
            }

            out.vertices =
                verts;

            out.inTangents =
                inTs;

            out.outTangents =
                outTs;

            return out;
        }

        if (pathProp.numKeys > 0) {
            for (
                var k = 1;
                k <= pathProp.numKeys;
                k++
            ) {
                var s =
                    pathProp.keyValue(k);

                pathProp.setValueAtKey(
                    k,
                    scaledShape(s)
                );
            }

        } else {
            pathProp.setValue(
                scaledShape(
                    pathProp.value
                )
            );
        }
    }

    function isShapeLayerSafe(layer) {
        if (!layer) return false;

        try {
            return (
                layer.matchName ===
                "ADBE Vector Layer"
            );
        } catch (e) {
            return false;
        }
    }

    function isNullLayerSafe(layer) {
        if (!layer) return false;

        try {
            return (
                layer.matchName ===
                "ADBE Null Layer"
            );
        } catch (e) {
            return false;
        }
    }

    function readDropdownLayerIndex(dropdown) {
        if (!dropdown || !dropdown.selection) {
            return 0;
        }

        try {
            return dropdown.selection.layerIndex || 0;
        } catch (e) {
            return 0;
        }
    }

    // ============================================================
    // 多元素模板适配器 v2.1
    //
    // 每个模板最多可配置 6 条元素规则。
    //
    // 支持模式：
    // 0 不处理
    // 1 水平拉伸
    // 2 矩形固定留白
    // 3 跟随文字右边缘
    // 4 跟随文字左边缘
    // 5 始终水平居中
    // 6 保持不动
    //
    // 典型用法：
    // 蓝色笔刷 -> 水平拉伸
    // 虚线     -> 水平拉伸
    // 三角形   -> 始终水平居中
    // 右箭头   -> 跟随文字右边缘
    // ============================================================

    function getBoundsCenterX(bounds) {
        if (!bounds) return 0;
        return bounds.left + bounds.width / 2;
    }

    function getRuleModeIndex(dropdown) {
        if (!dropdown || !dropdown.selection) {
            return 0;
        }

        try {
            return dropdown.selection.index;
        } catch (e) {
            return 0;
        }
    }

    function captureAdapterConfig(selection, settings) {
        if (
            !cbEnableAdapter ||
            !cbEnableAdapter.value
        ) {
            return null;
        }

        var comp =
            selection.labelMaster;

        var textLayer =
            findTextLayer(
                comp,
                selection.textLayerName,
                selection.textLayerIndex
            );

        if (!textLayer) {
            throw new Error(
                "多元素模板适配器：找不到目标文字图层。"
            );
        }

        var sampleTime =
            Math.min(
                settings.sampleTime,
                comp.duration -
                comp.frameDuration
            );

        if (sampleTime < 0) {
            sampleTime = 0;
        }

        forceRefreshComp(
            comp,
            sampleTime
        );

        var textBounds =
            getLayerVisualBounds(
                comp,
                textLayer,
                sampleTime
            );

        if (!textBounds) {
            throw new Error(
                "多元素模板适配器：无法读取原标题文字边界。"
            );
        }

        var config = {
            enabled: true,
            textLayerName: selection.textLayerName,
            textLayerIndex: selection.textLayerIndex,
            sampleTime: sampleTime,

            originalTextBounds: {
                left: textBounds.left,
                right: textBounds.right,
                top: textBounds.top,
                bottom: textBounds.bottom,
                width: textBounds.width,
                height: textBounds.height,
                centerX: getBoundsCenterX(
                    textBounds
                )
            },

            rules: []
        };

        for (
            var i = 0;
            i < adapterRuleLayerDropdowns.length;
            i++
        ) {
            var layerDropdown =
                adapterRuleLayerDropdowns[i];

            var modeDropdown =
                adapterRuleModeDropdowns[i];

            var layerIndex =
                readDropdownLayerIndex(
                    layerDropdown
                );

            var modeIndex =
                getRuleModeIndex(
                    modeDropdown
                );

            if (
                layerIndex <= 0 ||
                modeIndex === 0
            ) {
                continue;
            }

            var layer =
                getLayerByIndexSafe(
                    comp,
                    layerIndex
                );

            if (!layer) {
                throw new Error(
                    "多元素模板适配器：规则 " +
                    (i + 1) +
                    " 的目标图层不存在。"
                );
            }

            var layerBounds =
                getLayerVisualBounds(
                    comp,
                    layer,
                    sampleTime
                );

            var rule = {
                slot: i + 1,
                layerIndex: layerIndex,
                layerName: layer.name,
                modeIndex: modeIndex,

                originalLayerWidth:
                    layerBounds
                    ? layerBounds.width
                    : 0,

                originalLayerCenterX:
                    layerBounds
                    ? getBoundsCenterX(
                        layerBounds
                    )
                    : 0,

                originalCenterOffset:
                    layerBounds
                    ? (
                        getBoundsCenterX(
                            layerBounds
                        ) -
                        config.originalTextBounds.centerX
                    )
                    : 0,

                originalPadding: 0
            };

            // Rectangle固定留白模式：
            // 自动测量当前矩形宽度 - 当前文字宽度
            if (modeIndex === 2) {
                var rectSize =
                    findLargestRectSizeProp(
                        layer,
                        sampleTime
                    );

                if (!rectSize) {
                    throw new Error(
                        "多元素模板适配器：规则 " +
                        (i + 1) +
                        " 选择了“矩形固定留白”，" +
                        "但该图层找不到 Rectangle Path > Size。"
                    );
                }

                var rectValue =
                    rectSize.valueAtTime(
                        sampleTime,
                        false
                    );

                rule.originalPadding =
                    Math.max(
                        0,
                        rectValue[0] -
                        textBounds.width
                    );
            }

            config.rules.push(
                rule
            );
        }

        if (config.rules.length === 0) {
            throw new Error(
                "已启用模板适配器，但还没有配置任何元素规则。\n\n" +
                "请至少选择一个图层，并为它选择适配方式。"
            );
        }

        return config;
    }

    function applyScaleXRatio(layer, ratio) {
        if (!layer) return;

        var scaleProp =
            layer
            .property("ADBE Transform Group")
            .property("ADBE Scale");

        if (!scaleProp) {
            throw new Error(
                "无法访问图层 Scale。"
            );
        }

        if (scaleProp.numKeys > 0) {
            for (
                var k = 1;
                k <= scaleProp.numKeys;
                k++
            ) {
                var value =
                    scaleProp.keyValue(k);

                value[0] =
                    value[0] *
                    ratio;

                scaleProp.setValueAtKey(
                    k,
                    value
                );
            }

        } else {
            var s =
                scaleProp.value;

            s[0] =
                s[0] *
                ratio;

            scaleProp.setValue(
                s
            );
        }
    }

    function applyAdapterToComp(comp, config) {
        if (
            !config ||
            !config.enabled
        ) {
            return;
        }

        var sampleTime =
            Math.min(
                config.sampleTime,
                comp.duration -
                comp.frameDuration
            );

        if (sampleTime < 0) {
            sampleTime = 0;
        }

        forceRefreshComp(
            comp,
            sampleTime
        );

        var textLayer =
            findTextLayer(
                comp,
                config.textLayerName,
                config.textLayerIndex
            );

        if (!textLayer) {
            throw new Error(
                "多元素模板适配器：复制后的标题中找不到文字图层：" +
                config.textLayerName
            );
        }

        var newTextBounds =
            getLayerVisualBounds(
                comp,
                textLayer,
                sampleTime
            );

        if (!newTextBounds) {
            throw new Error(
                "多元素模板适配器：无法读取新文字边界。"
            );
        }

        var oldText =
            config.originalTextBounds;

        var newTextCenterX =
            getBoundsCenterX(
                newTextBounds
            );

        var textWidthDelta =
            newTextBounds.width -
            oldText.width;

        var textRightDelta =
            newTextBounds.right -
            oldText.right;

        var textLeftDelta =
            newTextBounds.left -
            oldText.left;

        for (
            var i = 0;
            i < config.rules.length;
            i++
        ) {
            var rule =
                config.rules[i];

            var layer =
                getLayerByIndexSafe(
                    comp,
                    rule.layerIndex
                );

            if (!layer) {
                throw new Error(
                    "多元素模板适配器：复制后的标题中找不到规则图层：" +
                    rule.layerName
                );
            }

            // ----------------------------------------------------
            // 1. 水平拉伸
            //
            // 目标宽度 = 原元素宽度 + 文字宽度变化量
            // 这样保留元素与文字之间原来的额外宽度。
            //
            // 拉伸后再重新居中到：
            // 新文字中心 + 原来的中心偏移
            // ----------------------------------------------------
            if (rule.modeIndex === 1) {
                if (
                    rule.originalLayerWidth <= 0
                ) {
                    throw new Error(
                        "规则“水平拉伸”无法读取原标题元素宽度：" +
                        rule.layerName
                    );
                }

                var desiredWidth =
                    Math.max(
                        1,
                        rule.originalLayerWidth +
                        textWidthDelta
                    );

                var ratio =
                    desiredWidth /
                    rule.originalLayerWidth;

                applyScaleXRatio(
                    layer,
                    ratio
                );

                forceRefreshComp(
                    comp,
                    sampleTime
                );

                var stretchedBounds =
                    getLayerVisualBounds(
                        comp,
                        layer,
                        sampleTime
                    );

                if (stretchedBounds) {
                    var currentCenter =
                        getBoundsCenterX(
                            stretchedBounds
                        );

                    var targetCenter =
                        newTextCenterX +
                        rule.originalCenterOffset;

                    offsetPosition(
                        layer,
                        targetCenter -
                        currentCenter,
                        0
                    );
                }
            }

            // ----------------------------------------------------
            // 2. Rectangle Size 固定留白
            // ----------------------------------------------------
            else if (rule.modeIndex === 2) {
                var rectSizeProp =
                    findLargestRectSizeProp(
                        layer,
                        sampleTime
                    );

                if (!rectSizeProp) {
                    throw new Error(
                        "复制后的标题中找不到 Rectangle Size：" +
                        rule.layerName
                    );
                }

                // Text Layer 如果没有手动改“图层名”，AE 会随着 Source Text
                // 自动改图层显示名称。因此不能用 layer("名字") 做表达式引用。
                // Duplicate Comp 会保留图层顺序，所以这里固定按 layer(index) 引用。
                var expr =
                    'var t=thisComp.layer(' +
                    config.textLayerIndex +
                    ');\n' +
                    'var r=t.sourceRectAtTime(time,false);\n' +
                    '[r.width+' +
                    rule.originalPadding.toFixed(3) +
                    ',value[1]];';

                rectSizeProp.expression =
                    expr;

                rectSizeProp.expressionEnabled =
                    true;
            }

            // ----------------------------------------------------
            // 3. 跟随文字右边缘
            // ----------------------------------------------------
            else if (rule.modeIndex === 3) {
                offsetPosition(
                    layer,
                    textRightDelta,
                    0
                );
            }

            // ----------------------------------------------------
            // 4. 跟随文字左边缘
            // ----------------------------------------------------
            else if (rule.modeIndex === 4) {
                offsetPosition(
                    layer,
                    textLeftDelta,
                    0
                );
            }

            // ----------------------------------------------------
            // 5. 始终水平居中
            //
            // 直接让这个元素的视觉中心 = 新文字视觉中心
            // ----------------------------------------------------
            else if (rule.modeIndex === 5) {
                var centerBounds =
                    getLayerVisualBounds(
                        comp,
                        layer,
                        sampleTime
                    );

                if (centerBounds) {
                    var layerCenter =
                        getBoundsCenterX(
                            centerBounds
                        );

                    offsetPosition(
                        layer,
                        newTextCenterX -
                        layerCenter,
                        0
                    );
                }
            }

            // ----------------------------------------------------
            // 6. 保持不动
            // ----------------------------------------------------
            else if (rule.modeIndex === 6) {
                // intentionally no-op
            }

            // ----------------------------------------------------
            // 7. 路径横向延展（保持虚线/描边）
            //
            // 不改整层 Scale，只改 Shape Path 顶点的 X。
            // Stroke / Dashes / 圆角等样式不会被横向压扁。
            // ----------------------------------------------------
            else if (rule.modeIndex === 7) {
                if (
                    rule.originalLayerWidth <= 0
                ) {
                    throw new Error(
                        "规则“路径横向延展”无法读取原标题元素宽度：" +
                        rule.layerName
                    );
                }

                var desiredPathWidth =
                    Math.max(
                        1,
                        rule.originalLayerWidth +
                        textWidthDelta
                    );

                var pathRatio =
                    desiredPathWidth /
                    rule.originalLayerWidth;

                var pathProp =
                    findLargestShapePathProp(
                        layer,
                        sampleTime
                    );

                if (!pathProp) {
                    throw new Error(
                        "规则“路径横向延展”找不到 Shape Path：" +
                        rule.layerName
                    );
                }

                stretchShapePathX(
                    pathProp,
                    pathRatio
                );

                forceRefreshComp(
                    comp,
                    sampleTime
                );

                var pathBounds =
                    getLayerVisualBounds(
                        comp,
                        layer,
                        sampleTime
                    );

                if (pathBounds) {
                    var pathCenter =
                        getBoundsCenterX(
                            pathBounds
                        );

                    var targetPathCenter =
                        newTextCenterX +
                        rule.originalCenterOffset;

                    offsetPosition(
                        layer,
                        targetPathCenter -
                        pathCenter,
                        0
                    );
                }
            }

            forceRefreshComp(
                comp,
                sampleTime
            );
        }
    }

    function applyOutputTemplate(outputModule, templateName) {
        try {
            outputModule.applyTemplate(templateName);
            return true;
        } catch (e) {
            return false;
        }
    }

    function findUsageLayers(parentComp, childComp) {
        var result = [];
        for (var i = 1; i <= parentComp.numLayers; i++) {
            var layer = parentComp.layer(i);
            try {
                if (layer.source && layer.source === childComp) {
                    result.push(layer);
                }
            } catch (e) {}
        }
        return result;
    }

    function deselectAllLayers(comp) {
        if (!comp) return;
        for (var i = 1; i <= comp.numLayers; i++) {
            try { comp.layer(i).selected = false; } catch (e) {}
        }
    }

    function isRenderableLayer(layer) {
        try { if (!layer.enabled) return false; } catch (e0) {}
        try { if (layer.guideLayer) return false; } catch (e1) {}
        try { if (layer.nullLayer) return false; } catch (e2) {}
        try { if (layer instanceof CameraLayer) return false; } catch (e3) {}
        try { if (layer instanceof LightLayer) return false; } catch (e4) {}
        return true;
    }

    function forceRefreshComp(comp, sampleTime) {
        var frame = comp.frameDuration;
        if (!frame || frame <= 0) frame = 1 / 25;

        var preTime = sampleTime - frame;
        if (preTime < 0) preTime = 0;

        comp.time = preTime;
        $.sleep(180);
        comp.time = sampleTime;
        $.sleep(320);

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try { layer.sourceRectAtTime(sampleTime, true); } catch (e1) {}
            try {
                layer.property("ADBE Transform Group")
                    .property("ADBE Position")
                    .valueAtTime(sampleTime, false);
            } catch (e2) {}
            try {
                layer.property("ADBE Transform Group")
                    .property("ADBE Scale")
                    .valueAtTime(sampleTime, false);
            } catch (e3) {}
            try {
                layer.property("ADBE Transform Group")
                    .property("ADBE Anchor Point")
                    .valueAtTime(sampleTime, false);
            } catch (e4) {}
        }
        $.sleep(300);
    }

    function getVisibleBoundsInComp(comp, sampleTime) {
        var minX = null, minY = null, maxX = null, maxY = null;

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (!isRenderableLayer(layer)) continue;

            try {
                var rect = layer.sourceRectAtTime(sampleTime, true);
                if (Math.abs(rect.width) < 0.001 && Math.abs(rect.height) < 0.001) continue;

                var points = [
                    layer.sourcePointToComp([rect.left, rect.top]),
                    layer.sourcePointToComp([rect.left + rect.width, rect.top]),
                    layer.sourcePointToComp([rect.left, rect.top + rect.height]),
                    layer.sourcePointToComp([rect.left + rect.width, rect.top + rect.height])
                ];

                for (var p = 0; p < points.length; p++) {
                    var x = points[p][0], y = points[p][1];
                    if (minX === null || x < minX) minX = x;
                    if (minY === null || y < minY) minY = y;
                    if (maxX === null || x > maxX) maxX = x;
                    if (maxY === null || y > maxY) maxY = y;
                }
            } catch (eBounds) {}
        }

        if (minX === null || minY === null) return null;

        return {
            left: minX, top: minY,
            right: maxX, bottom: maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    function getBoundsInParent(childComp, usageLayer, sampleTime) {
        var bounds = getVisibleBoundsInComp(childComp, sampleTime);
        if (!bounds) return null;

        var points = [
            usageLayer.sourcePointToComp([bounds.left, bounds.top]),
            usageLayer.sourcePointToComp([bounds.right, bounds.top]),
            usageLayer.sourcePointToComp([bounds.left, bounds.bottom]),
            usageLayer.sourcePointToComp([bounds.right, bounds.bottom])
        ];

        var minX = points[0][0], minY = points[0][1];
        var maxX = points[0][0], maxY = points[0][1];

        for (var i = 1; i < points.length; i++) {
            minX = Math.min(minX, points[i][0]);
            minY = Math.min(minY, points[i][1]);
            maxX = Math.max(maxX, points[i][0]);
            maxY = Math.max(maxY, points[i][1]);
        }

        return {left:minX, top:minY, right:maxX, bottom:maxY};
    }


    // ============================================================
    // 获取“裁切后预合成画布左上角”在导出合成中的坐标
    //
    // 关键修正：
    // 新标题经过 Auto Crop 后，合成画布本身已经是裁切结果。
    // 左对齐不能再用文字/所有可见内容的 sourceRect，
    // 否则不同字符的左侧字面留白会造成几像素偏差。
    //
    // 所以新标题之间的 X 对齐，统一使用 [0,0] 画布左边界。
    // ============================================================

    function getCroppedCanvasTopLeftInParent(layer) {
        var p = layer.sourcePointToComp([0, 0]);

        return {
            x: p[0],
            y: p[1]
        };
    }


    // ============================================================
    // 直接居中扩展“当前标题合成”
    //
    // 不套 Wrapper，不生成 _CROP / _REFERENCE_SOURCE。
    //
    // 做法：
    // 1. 记录旧尺寸
    // 2. 直接修改 comp.width / comp.height
    // 3. 将内部所有图层整体平移尺寸差的一半
    //
    // 这样等价于画布向四周对称扩展，
    // 同时仍然是在原标题副本本身上工作。
    // ============================================================

    // 已废弃：v8.2.3 不再移动内部图层来扩展画布
    function expandCompCenteredDirect_UNUSED(comp, targetWidth, targetHeight) {
        var oldW = comp.width;
        var oldH = comp.height;

        var newW = Math.max(oldW, targetWidth);
        var newH = Math.max(oldH, targetHeight);

        if (newW === oldW && newH === oldH) {
            return;
        }

        var dx = (newW - oldW) / 2;
        var dy = (newH - oldH) / 2;

        // 先真正扩大合成画布
        comp.width = newW;
        comp.height = newH;

        // 再把内部所有图层整体移动一半，
        // 让原标题在新画布中保持居中区域。
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);

            try {
                offsetPosition(
                    layer,
                    dx,
                    dy
                );
            } catch (eMove) {}
        }
    }


    // ============================================================
    // 只移动“根图层”的居中扩展
    //
    // 目的：
    // - 直接扩大标题合成尺寸
    // - 不让长文字继续从左侧被裁
    // - 避免父子层被重复平移，造成文字/红框分家
    //
    // 原则：
    // 只移动 parent === null 的图层。
    // 有 parent 的子图层跟随父级一起移动。
    // ============================================================

    function expandTemplateByRootLayers(comp, targetWidth, targetHeight) {
        var oldW = comp.width;
        var oldH = comp.height;

        var newW = Math.max(oldW, targetWidth);
        var newH = Math.max(oldH, targetHeight);

        if (newW === oldW && newH === oldH) {
            return;
        }

        var dx = (newW - oldW) / 2;
        var dy = (newH - oldH) / 2;

        // 先扩大画布
        comp.width = newW;
        comp.height = newH;

        // 只移动根图层，避免父子层重复偏移
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);

            try {
                if (layer.parent === null) {
                    offsetPosition(
                        layer,
                        dx,
                        dy
                    );
                }
            } catch (eMove) {}
        }
    }

    function runAutoCrop(comp, sampleTime, exportDuration) {
        if (!comp) {
            throw new Error("Auto Crop：目标合成不存在。");
        }

        if (comp.duration < exportDuration) {
            comp.duration = exportDuration;
        }

        var maxTime = comp.duration - comp.frameDuration;

        if (sampleTime > maxTime) {
            sampleTime = maxTime;
        }

        if (sampleTime < 0) {
            sampleTime = 0;
        }

        var oldTime = comp.time;
        var viewer = null;

        try {
            viewer = comp.openInViewer();
        } catch (eOpen) {
            throw new Error("无法打开标题合成。");
        }

        $.sleep(280);

        if (viewer) {
            try {
                viewer.setActive();
            } catch (eViewer) {}
        }

        comp.time = sampleTime;

        deselectAllLayers(comp);

        forceRefreshComp(
            comp,
            sampleTime
        );

        deselectAllLayers(comp);

        if (viewer) {
            try {
                viewer.setActive();
            } catch (eViewer2) {}
        }

        comp.time = sampleTime;
        $.sleep(220);

        var commandId =
            app.findMenuCommandId(
                "Auto Crop"
            );

        if (
            !commandId ||
            commandId === 0
        ) {
            throw new Error(
                "没有找到“图层 > Auto Crop”命令。\n\n" +
                "请确认 Auto Crop 插件已经正确安装。"
            );
        }

        app.executeCommand(
            commandId
        );

        $.sleep(900);

        if (
            comp.width <= 2 ||
            comp.height <= 2
        ) {
            throw new Error(
                "Auto Crop 得到异常尺寸：" +
                comp.width +
                " × " +
                comp.height
            );
        }

        try {
            comp.time = oldTime;
        } catch (eRestore) {}

        return {
            width: comp.width,
            height: comp.height
        };
    }


    function copyTransform(sourceLayer, targetLayer) {
        var sourceTransform = sourceLayer.property("ADBE Transform Group");
        var targetTransform = targetLayer.property("ADBE Transform Group");

        var properties = [
            "ADBE Anchor Point",
            "ADBE Position",
            "ADBE Scale",
            "ADBE Rotate Z",
            "ADBE Opacity"
        ];

        for (var i = 0; i < properties.length; i++) {
            try {
                var src = sourceTransform.property(properties[i]);
                var dst = targetTransform.property(properties[i]);
                if (!src || !dst) continue;

                if (src.numKeys > 0) {
                    while (dst.numKeys > 0) dst.removeKey(1);

                    for (var k = 1; k <= src.numKeys; k++) {
                        dst.setValueAtTime(src.keyTime(k), src.keyValue(k));
                        try {
                            dst.setInterpolationTypeAtKey(
                                k,
                                src.keyInInterpolationType(k),
                                src.keyOutInterpolationType(k)
                            );
                        } catch (eInterp) {}
                    }
                } else {
                    dst.setValue(src.value);
                }
            } catch (e) {}
        }
    }


    // ============================================================
    // 只复制视觉属性，不复制 Anchor Point / Position
    //
    // 第③步专用：
    // Auto Crop 后，每个标题合成尺寸都不同。
    // 所以 Anchor / Position 不再沿用原标题模板，
    // 而是统一锁到 REFERENCE 的裁切后左上角。
    // ============================================================

    function copyVisualTransformOnly(sourceLayer, targetLayer) {
        var sourceTransform = sourceLayer.property("ADBE Transform Group");
        var targetTransform = targetLayer.property("ADBE Transform Group");

        var properties = [
            "ADBE Scale",
            "ADBE Rotate Z",
            "ADBE Opacity"
        ];

        for (var i = 0; i < properties.length; i++) {
            try {
                var src = sourceTransform.property(properties[i]);
                var dst = targetTransform.property(properties[i]);

                if (!src || !dst) continue;

                if (src.numKeys > 0) {
                    while (dst.numKeys > 0) {
                        dst.removeKey(1);
                    }

                    for (var k = 1; k <= src.numKeys; k++) {
                        dst.setValueAtTime(
                            src.keyTime(k),
                            src.keyValue(k)
                        );

                        try {
                            dst.setInterpolationTypeAtKey(
                                k,
                                src.keyInInterpolationType(k),
                                src.keyOutInterpolationType(k)
                            );
                        } catch (eInterp) {}
                    }

                } else {
                    dst.setValue(src.value);
                }

            } catch (e) {}
        }
    }

    function pinLayerTopLeft(layer, targetX, targetY) {
        var transform = layer.property("ADBE Transform Group");
        var anchor = transform.property("ADBE Anchor Point");
        var position = transform.property("ADBE Position");

        if (!anchor || !position) {
            throw new Error("无法访问图层 Anchor Point / Position。");
        }

        // 裁切后的预合成：[0,0] 就是合成左上角
        // 把 Anchor 固定在左上角，再把 Position 固定到模板参考位置。
        try {
            while (anchor.numKeys > 0) {
                anchor.removeKey(1);
            }
        } catch (eAnchorKeys) {}

        anchor.setValue([0, 0]);

        // 如果 Position 被分离维度，分别设置 X/Y
        try {
            if (position.dimensionsSeparated) {
                var xPos = transform.property("ADBE Position_0");
                var yPos = transform.property("ADBE Position_1");

                if (xPos) {
                    while (xPos.numKeys > 0) xPos.removeKey(1);
                    xPos.setValue(targetX);
                }

                if (yPos) {
                    while (yPos.numKeys > 0) yPos.removeKey(1);
                    yPos.setValue(targetY);
                }

                return;
            }
        } catch (eSeparated) {}

        try {
            while (position.numKeys > 0) {
                position.removeKey(1);
            }
        } catch (ePosKeys) {}

        position.setValue([targetX, targetY]);
    }

    function offsetPosition(layer, dx, dy) {
        if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;

        var transform = layer.property("ADBE Transform Group");
        var pos = transform.property("ADBE Position");
        if (!pos) return;

        try {
            if (pos.dimensionsSeparated) {
                var xPos = transform.property("ADBE Position_0");
                var yPos = transform.property("ADBE Position_1");

                if (xPos) {
                    if (xPos.numKeys > 0) {
                        for (var kx = 1; kx <= xPos.numKeys; kx++) {
                            xPos.setValueAtKey(kx, xPos.keyValue(kx) + dx);
                        }
                    } else xPos.setValue(xPos.value + dx);
                }

                if (yPos) {
                    if (yPos.numKeys > 0) {
                        for (var ky = 1; ky <= yPos.numKeys; ky++) {
                            yPos.setValueAtKey(ky, yPos.keyValue(ky) + dy);
                        }
                    } else yPos.setValue(yPos.value + dy);
                }
                return;
            }
        } catch (eSeparated) {}

        if (pos.numKeys > 0) {
            for (var k = 1; k <= pos.numKeys; k++) {
                var value = pos.keyValue(k);
                value[0] += dx;
                value[1] += dy;
                pos.setValueAtKey(k, value);
            }
        } else {
            var current = pos.value;
            current[0] += dx;
            current[1] += dy;
            pos.setValue(current);
        }
    }

    function cleanupGeneratedLayers(exportComp, labelMaster) {
        var exportPrefix = labelMaster.name + "_EXPORT_";
        var referenceName = labelMaster.name + "_REFERENCE";

        for (var i = exportComp.numLayers; i >= 1; i--) {
            var layer = exportComp.layer(i);
            try {
                if (
                    layer.source &&
                    layer.source instanceof CompItem &&
                    (
                        layer.source.name.indexOf(exportPrefix) === 0 ||
                        layer.source.name === referenceName
                    )
                ) {
                    layer.remove();
                }
            } catch (e) {}
        }
    }

    function cleanupGeneratedComps(labelMaster) {
        var exportPrefix = labelMaster.name + "_EXPORT_";
        var referenceName = labelMaster.name + "_REFERENCE";

        for (var i = app.project.numItems; i >= 1; i--) {
            var item = app.project.item(i);
            if (!(item instanceof CompItem)) continue;
            if (item === labelMaster) continue;

            if (
                item.name.indexOf(exportPrefix) === 0 ||
                item.name === referenceName
            ) {
                try { item.remove(); } catch (e) {}
            }
        }
    }

    function cleanupRenderQueueForComp(exportComp) {
        var rq = app.project.renderQueue;

        for (var i = rq.numItems; i >= 1; i--) {
            try {
                if (rq.item(i).comp === exportComp) rq.item(i).remove();
            } catch (e) {}
        }
    }

    function captureLayerStates(comp) {
        var states = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            states.push({
                layer: comp.layer(i),
                enabled: comp.layer(i).enabled
            });
        }
        return states;
    }

    function restoreLayerStates(states) {
        for (var i = 0; i < states.length; i++) {
            try { states[i].layer.enabled = states[i].enabled; } catch (e) {}
        }
    }

    function showOnlyCurrentLabel(comp, currentLayer) {
        for (var i = 1; i <= comp.numLayers; i++) {
            try {
                comp.layer(i).enabled = (comp.layer(i) === currentLayer);
            } catch (e) {}
        }
    }

    function resetBatch() {
        batch.exportComp = null;
        batch.labelMaster = null;
        batch.masterUsageLayer = null;
        batch.textLayerName = null;
        batch.textLayerIndex = 0;
        batch.adapterConfig = null;
        batch.referenceComp = null;
        batch.referenceLayer = null;
        batch.texts = [];
        batch.labelCopies = [];
        batch.placedLayers = [];
        batch.textDone = false;
        batch.cropDone = false;
        batch.placeDone = false;
        batch.exportDone = false;
        updateStatus();
    }

    var allComps = collectAllComps();
    var labelComps = collectLabelComps();

    if (allComps.length === 0) {
        alert("当前工程里没有合成。");
        return;
    }


    var win = new Window(
        "palette",
        "AE 标注批量生成器 v2.3.1",
        undefined,
        { resizeable: true }
    );

    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.spacing = 8;
    win.margins = 12;

    var topBar = win.add("group");
    topBar.orientation = "row";
    topBar.alignChildren = ["left", "center"];

    topBar.add("statictext", undefined, "视图：");

    var viewDropdown = topBar.add(
        "dropdownlist",
        undefined,
        ["基础设置", "模板适配器", "高级设置"]
    );
    viewDropdown.selection = 0;
    viewDropdown.preferredSize.width = 130;

    // ============================================================
    // v2.3.1 三面板布局修复
    //
    // 三个页面必须放进同一个 stack 容器中叠放。
    // 之前直接作为 win 的三个纵向 sibling，
    // ScriptUI 即使 visible=false 仍可能保留已计算过的布局高度，
    // 因此切换到模板适配器/高级设置时会出现巨大的空白区域。
    // ============================================================

    var pageHost = win.add("group");
    pageHost.orientation = "stack";
    pageHost.alignChildren = ["fill", "top"];
    pageHost.alignment = ["fill", "top"];
    pageHost.spacing = 0;
    pageHost.margins = 0;

    var basicContainer = pageHost.add("group");
    basicContainer.orientation = "column";
    basicContainer.alignChildren = ["fill", "top"];
    basicContainer.alignment = ["fill", "top"];
    basicContainer.spacing = 8;

    var commonPanel = basicContainer.add("panel", undefined, "基础设置");
    commonPanel.orientation = "column";
    commonPanel.alignChildren = ["fill", "top"];
    commonPanel.margins = 10;

    commonPanel.add("statictext", undefined, "导出合成");

    var exportRow =
        commonPanel.add("group");

    exportRow.orientation =
        "row";

    exportRow.alignChildren =
        ["fill", "center"];

    var exportDropdown =
        exportRow.add(
            "dropdownlist",
            undefined,
            []
        );

    exportDropdown.preferredSize.width =
        420;

    for (var i = 0; i < allComps.length; i++) {
        exportDropdown.add(
            "item",
            allComps[i].name
        );
    }

    if (exportDropdown.items.length > 0) {
        exportDropdown.selection = 0;
    }


    commonPanel.add("statictext", undefined, "标题模板");

    var labelRow =
        commonPanel.add("group");

    labelRow.orientation =
        "row";

    labelRow.alignChildren =
        ["fill", "center"];

    var labelDropdown =
        labelRow.add(
            "dropdownlist",
            undefined,
            []
        );

    labelDropdown.preferredSize.width =
        420;

    var refreshTemplatesButton =
        labelRow.add(
            "button",
            undefined,
            "刷新"
        );

    refreshTemplatesButton.preferredSize.width =
        55;

    for (var j = 0; j < labelComps.length; j++) {
        labelDropdown.add(
            "item",
            labelComps[j].name
        );
    }

    if (labelDropdown.items.length > 0) {
        labelDropdown.selection = 0;
    }

    refreshTemplatesButton.onClick =
        function () {
            refreshCompDropdowns(true);
        };

    commonPanel.add(
        "statictext",
        undefined,
        "需要修改的文字图层"
    );

    var textLayerRow =
        commonPanel.add("group");

    textLayerRow.orientation =
        "row";

    textLayerRow.alignChildren =
        ["fill", "center"];

    var textLayerDropdown =
        textLayerRow.add(
            "dropdownlist",
            undefined,
            []
        );

    textLayerDropdown.preferredSize.width =
        420;

    var refreshTextLayerButton =
        textLayerRow.add(
            "button",
            undefined,
            "刷新"
        );

    refreshTextLayerButton.preferredSize.width =
        55;

    labelDropdown.onChange =
        function () {
            refreshTextLayerDropdown(
                null
            );

            refreshAdapterLayerDropdowns();

            if (
                typeof cbAutoAnalyzeTemplate !== "undefined" &&
                cbAutoAnalyzeTemplate &&
                cbAutoAnalyzeTemplate.value
            ) {
                smartAnalyzeCurrentTemplate(
                    false
                );
            }
        };

    refreshTextLayerButton.onClick =
        function () {
            var currentName =
                textLayerDropdown.selection
                ? textLayerDropdown.selection.text
                : null;

            refreshTextLayerDropdown(
                currentName
            );
        };

    textLayerDropdown.onChange =
        function () {
            if (
                typeof cbAutoAnalyzeTemplate !== "undefined" &&
                cbAutoAnalyzeTemplate &&
                cbAutoAnalyzeTemplate.value
            ) {
                smartAnalyzeCurrentTemplate(
                    false
                );
            }
        };


    refreshTextLayerDropdown(
        null
    );

    var textPanel = basicContainer.add("panel", undefined, "批量文字（每行一条）");
    textPanel.orientation = "column";
    textPanel.alignChildren = ["fill", "top"];
    textPanel.margins = 10;

    var input = textPanel.add(
        "edittext",
        undefined,
        "",
        { multiline: true, scrolling: true }
    );
    input.preferredSize = [470, 150];

    var textCount = textPanel.add(
        "statictext",
        undefined,
        "共 0 条有效文字"
    );

    function refreshTextCount() {
        var lines = input.text.split(/\r\n|\r|\n/);
        var count = 0;
        for (var i = 0; i < lines.length; i++) {
            if (trimText(lines[i]) !== "") count++;
        }
        textCount.text = "共 " + count + " 条有效文字";
    }
    input.onChanging = refreshTextCount;

    var basicPanel = basicContainer.add("panel", undefined, "一键运行");
    basicPanel.orientation = "column";
    basicPanel.alignChildren = ["fill", "top"];
    basicPanel.margins = 10;

    var btnRunAll = basicPanel.add(
        "button",
        undefined,
        "一键执行四步流程"
    );
    btnRunAll.preferredSize.height = 45;

    var btnCleanupBasic = basicPanel.add(
        "button",
        undefined,
        "一键清理旧批次"
    );
    btnCleanupBasic.preferredSize.height = 34;

    basicPanel.add(
        "statictext",
        undefined,
        "模板根图层居中扩展并改字 → 批量Auto Crop → 批量位置对齐 → 批量导出渲染"
    );

    var basicOutputPanel = basicContainer.add("panel", undefined, "输出");
    basicOutputPanel.orientation = "column";
    basicOutputPanel.alignChildren = ["left", "top"];
    basicOutputPanel.margins = 10;

    var basicFormatGroup = basicOutputPanel.add("group");

    var rbAlpha = basicFormatGroup.add(
        "radiobutton",
        undefined,
        "ProRes 4444 XQ + Alpha"
    );

    var rb422 = basicFormatGroup.add(
        "radiobutton",
        undefined,
        "ProRes 422 HQ"
    );

    rbAlpha.value = true;

    var basicFolderGroup = basicOutputPanel.add("group");

    var folderField = basicFolderGroup.add("edittext", undefined, "");
    folderField.characters = 34;

    var folderButton = basicFolderGroup.add("button", undefined, "选择...");

    var selectedFolder = null;

    folderButton.onClick = function () {
        var f = Folder.selectDialog("选择输出文件夹");
        if (!f) return;
        selectedFolder = f;
        folderField.text = f.fsName;
    };

    var basicStatus = basicContainer.add("statictext", undefined, "状态：未开始");

    var templateContainer = pageHost.add("group");
    templateContainer.orientation = "column";
    templateContainer.alignChildren = ["fill", "top"];
    templateContainer.alignment = ["fill", "top"];
    templateContainer.spacing = 8;

    var advancedContainer = pageHost.add("group");
    advancedContainer.orientation = "column";
    advancedContainer.alignChildren = ["fill", "top"];
    advancedContainer.alignment = ["fill", "top"];
    advancedContainer.spacing = 8;

    var stepsPanel = advancedContainer.add("panel", undefined, "四步操作");
    stepsPanel.orientation = "column";
    stepsPanel.alignChildren = ["fill", "top"];
    stepsPanel.margins = 10;

    var btnStep1 = stepsPanel.add("button", undefined, "① 修改文本 + 根图层居中扩展");
    var btnStep2 = stepsPanel.add("button", undefined, "② 批量 Auto Crop");
    var btnStep3 = stepsPanel.add("button", undefined, "③ 批量位置对齐");
    var btnStep4 = stepsPanel.add("button", undefined, "④ 批量导出渲染");

    var paramPanel = advancedContainer.add("panel", undefined, "参数设置");
    paramPanel.orientation = "column";
    paramPanel.alignChildren = ["left", "top"];
    paramPanel.margins = 10;

    var widthGroup = paramPanel.add("group");
    widthGroup.add("statictext", undefined, "临时画布宽：");
    var expandWidthField = widthGroup.add(
        "edittext",
        undefined,
        String(DEFAULT_EXPAND_WIDTH)
    );
    expandWidthField.characters = 7;
    widthGroup.add("statictext", undefined, "px");

    var heightGroup = paramPanel.add("group");
    heightGroup.add("statictext", undefined, "临时画布高：");
    var expandHeightField = heightGroup.add(
        "edittext",
        undefined,
        String(DEFAULT_EXPAND_HEIGHT)
    );
    expandHeightField.characters = 7;
    heightGroup.add("statictext", undefined, "px");

    var sampleGroup = paramPanel.add("group");
    sampleGroup.add("statictext", undefined, "Auto Crop 取样时间：");
    var sampleTimeField = sampleGroup.add(
        "edittext",
        undefined,
        String(DEFAULT_SAMPLE_TIME)
    );
    sampleTimeField.characters = 6;
    sampleGroup.add("statictext", undefined, "秒");

    var durationGroup = paramPanel.add("group");
    durationGroup.add("statictext", undefined, "最终导出时长：");
    var exportDurationField = durationGroup.add(
        "edittext",
        undefined,
        String(DEFAULT_EXPORT_TIME)
    );
    exportDurationField.characters = 6;
    durationGroup.add("statictext", undefined, "秒");


    // ============================================================
    // 模板适配器
    // ============================================================

    var adapterPanel =
        templateContainer.add(
            "panel",
            undefined,
            "智能模板识别（新项目推荐）"
        );

    adapterPanel.orientation =
        "column";

    adapterPanel.alignChildren =
        ["fill", "top"];

    adapterPanel.margins = 10;

    var smartRow =
        adapterPanel.add("group");

    smartRow.orientation =
        "row";

    var cbAutoAnalyzeTemplate =
        smartRow.add(
            "checkbox",
            undefined,
            "切换模板时自动分析"
        );

    cbAutoAnalyzeTemplate.value =
        true;

    var smartAnalyzeButton =
        smartRow.add(
            "button",
            undefined,
            "🔍 自动分析当前模板"
        );

    var cbEnableAdapter =
        adapterPanel.add(
            "checkbox",
            undefined,
            "启用智能模板适配"
        );

    cbEnableAdapter.value = false;

    var adapterAnalysisText =
        adapterPanel.add(
            "statictext",
            undefined,
            "请选择标题模板和文字图层，脚本会自动判断背景、虚线、边缘装饰和居中元素。"
        );

    smartAnalyzeButton.onClick =
        function () {
            smartAnalyzeCurrentTemplate(
                true
            );
        };

    adapterPanel.add(
        "statictext",
        undefined,
        "自动识别会保护旋转箭头/三角形；虚线优先改路径/矩形尺寸；背景继续跟随文字变长。文字层引用改为稳定的图层索引，避免改字后自动改名导致表达式失效。"
    );

    var adapterHeader =
        adapterPanel.add("group");

    adapterHeader.orientation =
        "row";

    var h1 =
        adapterHeader.add(
            "statictext",
            undefined,
            "图层"
        );

    h1.preferredSize.width = 260;

    var h2 =
        adapterHeader.add(
            "statictext",
            undefined,
            "适配方式"
        );

    h2.preferredSize.width = 260;

    var adapterRuleLayerDropdowns = [];
    var adapterRuleModeDropdowns = [];

    // 记录上一次刷新时的模板。
    // 同一模板刷新时保留右侧规则；切换新模板时右侧规则重置为“不处理”。
    var adapterLastTemplateName = null;

    var adapterModeNames = [
        "不处理",
        "水平拉伸",
        "矩形固定留白",
        "跟随文字右边缘",
        "跟随文字左边缘",
        "始终水平居中",
        "保持不动",
        "路径横向延展（保持虚线/描边）"
    ];

    for (
        var ar = 0;
        ar < 6;
        ar++
    ) {
        var ruleRow =
            adapterPanel.add("group");

        ruleRow.orientation =
            "row";

        ruleRow.add(
            "statictext",
            undefined,
            (ar + 1) + "."
        );

        var layerDropdown =
            ruleRow.add(
                "dropdownlist",
                undefined,
                []
            );

        layerDropdown.preferredSize.width =
            245;

        var modeDropdown =
            ruleRow.add(
                "dropdownlist",
                undefined,
                adapterModeNames
            );

        modeDropdown.preferredSize.width =
            245;

        modeDropdown.selection = 0;

        adapterRuleLayerDropdowns.push(
            layerDropdown
        );

        adapterRuleModeDropdowns.push(
            modeDropdown
        );
    }

    var adapterRefreshButton =
        adapterPanel.add(
            "button",
            undefined,
            "重新扫描图层列表"
        );

    adapterRefreshButton.onClick =
        function () {
            refreshAdapterLayerDropdowns();

            if (
                cbAutoAnalyzeTemplate.value
            ) {
                smartAnalyzeCurrentTemplate(
                    false
                );
            }
        };

    adapterPanel.add(
        "statictext",
        undefined,
        "智能识别会优先填入真正相关的设计元素；下方 6 行保留作为人工校正入口。"
    );

    refreshAdapterLayerDropdowns();

    var alignPanel = advancedContainer.add("panel", undefined, "对齐设置");
    alignPanel.orientation = "column";
    alignPanel.alignChildren = ["left", "top"];
    alignPanel.margins = 10;

    var cbActualMasterBounds = alignPanel.add(
        "checkbox",
        undefined,
        "固定原标题模板位置 → 新标题锁定同一左上角"
    );
    cbActualMasterBounds.value = true;

    var cbAlignLeftTop = alignPanel.add(
        "checkbox",
        undefined,
        "左边 + 顶边对齐"
    );
    cbAlignLeftTop.value = true;

    alignPanel.add(
        "statictext",
        undefined,
        "原模板不改；脚本复制一个 _REFERENCE，与新标题一起 Auto Crop 后用于对齐。"
    );

    var advOutputPanel = advancedContainer.add("panel", undefined, "导出设置");
    advOutputPanel.orientation = "column";
    advOutputPanel.alignChildren = ["left", "top"];
    advOutputPanel.margins = 10;

    advOutputPanel.add(
        "statictext",
        undefined,
        "输出格式沿用基础设置中的选择。"
    );

    var cbOpenFolderAfter = advOutputPanel.add(
        "checkbox",
        undefined,
        "导出完成后打开输出文件夹"
    );
    cbOpenFolderAfter.value = false;

    var toolsPanel = advancedContainer.add("panel", undefined, "工具");
    toolsPanel.orientation = "row";
    toolsPanel.margins = 10;

    // 清理按钮已移到“基础设置”，这里复用同一按钮逻辑，不再重复显示。
    var btnCleanup = btnCleanupBasic;
    var btnReset = toolsPanel.add("button", undefined, "重置状态");

    var statusPanel = advancedContainer.add("panel", undefined, "当前状态");
    statusPanel.orientation = "column";
    statusPanel.alignChildren = ["left", "top"];
    statusPanel.margins = 10;

    var statusText = statusPanel.add("statictext", undefined, "");

    function updateStatus() {
        statusText.text =
            "文本：" + (batch.textDone ? "✓ " + batch.labelCopies.length + " 条" : "未处理") +
            "\n裁切：" + (batch.cropDone ? "✓ 已完成" : "未处理") +
            "\n放入导出合成：" + (batch.placeDone ? "✓ 已完成" : "未处理") +
            "\n导出：" + (batch.exportDone ? "✓ 已完成" : "未处理");

        var simple = [];
        if (batch.textDone) simple.push("文本✓");
        if (batch.cropDone) simple.push("裁切✓");
        if (batch.placeDone) simple.push("对齐✓");
        if (batch.exportDone) simple.push("导出✓");

        basicStatus.text =
            simple.length > 0
            ? "状态：" + simple.join("  ")
            : "状态：未开始";
    }

    updateStatus();

    function setView(viewIndex) {
        basicContainer.visible = false;
        templateContainer.visible = false;
        advancedContainer.visible = false;

        if (viewIndex === 0) {
            basicContainer.visible = true;
        } else if (viewIndex === 1) {
            templateContainer.visible = true;
        } else {
            advancedContainer.visible = true;
        }

        // 先重排 stack 页面，再重排整个窗口。
        // 这样切换后内容直接从“视图”下方开始，不再保留旧页面高度。
        try {
            pageHost.layout.layout(true);
            pageHost.layout.resize();
        } catch (ePageLayout) {}

        try {
            win.layout.layout(true);
            win.layout.resize();
        } catch (eWinLayout) {}
    }

    viewDropdown.onChange = function () {
        setView(viewDropdown.selection.index);
    };

    setView(0);

    function getSettings() {
        var expandW = parseInt(expandWidthField.text, 10);
        var expandH = parseInt(expandHeightField.text, 10);
        var sampleTime = parseFloat(sampleTimeField.text);
        var exportDuration = parseFloat(exportDurationField.text);

        if (isNaN(expandW) || expandW < 100) expandW = DEFAULT_EXPAND_WIDTH;
        if (isNaN(expandH) || expandH < 50) expandH = DEFAULT_EXPAND_HEIGHT;
        if (isNaN(sampleTime) || sampleTime < 0) sampleTime = DEFAULT_SAMPLE_TIME;
        if (isNaN(exportDuration) || exportDuration <= 0) exportDuration = DEFAULT_EXPORT_TIME;

        return {
            expandW: expandW,
            expandH: expandH,
            sampleTime: sampleTime,
            exportDuration: exportDuration
        };
    }

    function getCurrentSelection() {
        var exportComp =
            getDropdownComp(
                exportDropdown,
                allComps
            );

        var labelMaster =
            getDropdownComp(
                labelDropdown,
                labelComps
            );

        if (!exportComp || !labelMaster) {
            throw new Error(
                "请先选择导出合成和标题模板。"
            );
        }

        if (!textLayerDropdown.selection) {
            throw new Error(
                "请先选择需要修改的文字图层。\n" +
                "如果刚切换了标题模板，可以点击右侧刷新。"
            );
        }

        var textLayerName =
            textLayerDropdown.selection.text;

        var textLayerIndex =
            textLayerDropdown.selection.layerIndex || 0;

        var targetTextLayer =
            findTextLayer(
                labelMaster,
                textLayerName,
                textLayerIndex
            );

        if (!targetTextLayer) {
            throw new Error(
                "当前标题模板中找不到文字图层：" +
                textLayerName
            );
        }

        var usage =
            findUsageLayers(
                exportComp,
                labelMaster
            );

        if (usage.length === 0) {
            throw new Error(
                "导出合成中没有直接使用这个标题模板。"
            );
        }

        return {
            exportComp: exportComp,
            labelMaster: labelMaster,
            masterUsageLayer: usage[0],
            textLayerName: textLayerName,
            textLayerIndex: textLayerIndex
        };
    }

    function parseTexts() {
        var lines = input.text.split(/\r\n|\r|\n/);
        var texts = [];

        for (var i = 0; i < lines.length; i++) {
            var t = trimText(lines[i]);
            if (t !== "") texts.push(t);
        }

        return texts;
    }

    function doStep1(showAlert) {
        var selection = getCurrentSelection();
        var texts = parseTexts();
        var settings = getSettings();

        if (texts.length === 0) {
            throw new Error(
                "请输入至少一条批量文字。"
            );
        }

        cleanupGeneratedLayers(
            selection.exportComp,
            selection.labelMaster
        );

        cleanupGeneratedComps(
            selection.labelMaster
        );

        cleanupRenderQueueForComp(
            selection.exportComp
        );

        resetBatch();

        batch.exportComp =
            selection.exportComp;

        batch.labelMaster =
            selection.labelMaster;

        batch.masterUsageLayer =
            selection.masterUsageLayer;

        batch.textLayerName =
            selection.textLayerName;

        batch.textLayerIndex =
            selection.textLayerIndex;

        batch.adapterConfig =
            captureAdapterConfig(
                selection,
                settings
            );

        batch.texts =
            texts;

        app.beginUndoGroup(
            "v8.2.3 根图层居中扩展 + 批量复制"
        );

        // --------------------------------------------------------
        // 关键：
        //
        // 先把“标题模板”临时扩到统一大尺寸，
        // 但只移动 parent === null 的根图层。
        //
        // 子图层不单独移动，避免文字和红框被重复偏移。
        //
        // 然后从这个已经正确扩展的模板统一复制
        // REFERENCE 和所有 EXPORT。
        // --------------------------------------------------------

        var originalW =
            selection.labelMaster.width;

        var originalH =
            selection.labelMaster.height;

        // 为了恢复原标题模板，记录所有根图层原始 Position
        var rootStates = [];

        for (
            var ri = 1;
            ri <= selection.labelMaster.numLayers;
            ri++
        ) {
            var rLayer =
                selection.labelMaster.layer(ri);

            try {
                if (rLayer.parent === null) {
                    rootStates.push({
                        layer: rLayer,
                        pos: rLayer
                            .property("ADBE Transform Group")
                            .property("ADBE Position")
                            .value
                    });
                }
            } catch (eRootSave) {}
        }

        try {
            // 1. 先把母版临时扩展
            expandTemplateByRootLayers(
                selection.labelMaster,
                settings.expandW,
                settings.expandH
            );

            // 2. 强制刷新一次
            var masterSampleTime =
                Math.min(
                    settings.sampleTime,
                    selection.labelMaster.duration -
                    selection.labelMaster.frameDuration
                );

            if (masterSampleTime < 0) {
                masterSampleTime = 0;
            }

            forceRefreshComp(
                selection.labelMaster,
                masterSampleTime
            );

            // ====================================================
            // A. REFERENCE
            // ====================================================

            batch.referenceComp =
                selection.labelMaster.duplicate();

            batch.referenceComp.name =
                selection.labelMaster.name +
                "_REFERENCE";

            if (
                batch.referenceComp.duration <
                settings.exportDuration
            ) {
                batch.referenceComp.duration =
                    settings.exportDuration;
            }

            if (batch.adapterConfig) {
                applyAdapterToComp(
                    batch.referenceComp,
                    batch.adapterConfig
                );
            }

            // ====================================================
            // B. 所有新标题
            // ====================================================

            for (
                var n = 0;
                n < texts.length;
                n++
            ) {
                var number =
                    ("0" + (n + 1))
                    .slice(-2);

                var newLabel =
                    selection.labelMaster.duplicate();

                newLabel.name =
                    selection.labelMaster.name +
                    "_EXPORT_" +
                    number;

                if (
                    newLabel.duration <
                    settings.exportDuration
                ) {
                    newLabel.duration =
                        settings.exportDuration;
                }

                // 复制完成后只改文字
                setTextInComp(
                    newLabel,
                    texts[n],
                    batch.textLayerName,
                    batch.textLayerIndex
                );

                if (batch.adapterConfig) {
                    applyAdapterToComp(
                        newLabel,
                        batch.adapterConfig
                    );
                }

                batch.labelCopies.push(
                    newLabel
                );
            }

            batch.textDone = true;
            batch.cropDone = false;
            batch.placeDone = false;
            batch.exportDone = false;

        } finally {
            // 恢复原标题模板尺寸
            try {
                selection.labelMaster.width =
                    originalW;

                selection.labelMaster.height =
                    originalH;
            } catch (eRestoreSize) {}

            // 恢复原标题模板根图层原始 Position
            for (
                var rs = 0;
                rs < rootStates.length;
                rs++
            ) {
                try {
                    var posProp =
                        rootStates[rs].layer
                        .property("ADBE Transform Group")
                        .property("ADBE Position");

                    if (
                        posProp &&
                        posProp.numKeys === 0
                    ) {
                        posProp.setValue(
                            rootStates[rs].pos
                        );
                    }
                } catch (eRestoreRoot) {}
            }

            app.endUndoGroup();
        }

        updateStatus();

        if (showAlert) {
            alert(
                "① 修改文本 + 统一扩展画布完成。\n\n" +
                "本版只移动标题模板里的根图层，\n" +
                "有父级的文字 / Shape 子图层不会重复偏移。\n\n" +
                "REFERENCE 和所有 EXPORT 均来自同一个已扩展模板。\n\n" +
                "现在请先检查：\n" +
                "• 合成尺寸统一\n" +
                "• 红框和文字相对位置正常\n" +
                "• 长标题左右都完整\n\n" +
                (
                    batch.adapterConfig
                    ?
                    "智能模板适配：已启用"
                    :
                    "智能模板适配：未启用"
                )
            );
        }
    }

    function doStep2(showAlert) {
        if (
            !batch.textDone ||
            batch.labelCopies.length === 0
        ) {
            throw new Error(
                "请先执行第①步：修改文本 + 扩展画布。"
            );
        }

        if (!batch.referenceComp) {
            throw new Error(
                "没有找到 REFERENCE，请重新执行第①步。"
            );
        }

        var settings = getSettings();

        app.beginUndoGroup(
            "v8.2.3 批量 Auto Crop"
        );

        var success = 0;
        var failed = 0;
        var firstError = null;

        try {
            // REFERENCE
            try {
                runAutoCrop(
                    batch.referenceComp,
                    settings.sampleTime,
                    settings.exportDuration
                );

                success++;

            } catch (refErr) {
                failed++;

                firstError =
                    new Error(
                        "REFERENCE Auto Crop 失败：\n" +
                        refErr.toString()
                    );
            }

            // 所有新标题
            if (failed === 0) {
                for (
                    var i = 0;
                    i < batch.labelCopies.length;
                    i++
                ) {
                    try {
                        runAutoCrop(
                            batch.labelCopies[i],
                            settings.sampleTime,
                            settings.exportDuration
                        );

                        success++;

                    } catch (err) {
                        failed++;

                        if (!firstError) {
                            firstError = err;
                        }
                    }
                }
            }

        } finally {
            app.endUndoGroup();
        }

        batch.cropDone =
            (failed === 0);

        batch.placeDone =
            false;

        batch.exportDone =
            false;

        updateStatus();

        if (failed > 0) {
            throw new Error(
                "Auto Crop 有 " +
                failed +
                " 项失败。\n\n" +
                (
                    firstError
                    ?
                    firstError.toString()
                    :
                    ""
                )
            );
        }

        if (showAlert) {
            alert(
                "② 批量 Auto Crop 完成。\n\n" +
                "已裁切：\n" +
                "• REFERENCE\n" +
                "• " +
                batch.labelCopies.length +
                " 个新标题\n\n" +
                "每条标题都保留自己的实际尺寸。"
            );
        }
    }

    function doStep3(showAlert) {
        if (!batch.cropDone) {
            throw new Error("请先完成第②步 Auto Crop。");
        }

        if (!batch.referenceComp) {
            throw new Error(
                "没有找到 Auto Crop 后的 REFERENCE。\n" +
                "请重新执行第②步。"
            );
        }

        var settings = getSettings();
        var exportComp = batch.exportComp;
        var masterLayer = batch.masterUsageLayer;

        if (!exportComp || !masterLayer) {
            throw new Error("母版数据不存在，请重新从第①步开始。");
        }

        cleanupGeneratedLayers(
            exportComp,
            batch.labelMaster
        );

        batch.placedLayers = [];
        batch.referenceLayer = null;

        var masterSampleTime = Math.min(
            settings.sampleTime,
            batch.labelMaster.duration -
            batch.labelMaster.frameDuration
        );

        if (masterSampleTime < 0) {
            masterSampleTime = 0;
        }

        forceRefreshComp(
            batch.labelMaster,
            masterSampleTime
        );

        // 原版标题模板在导出合成中的真实视觉边界
        var masterBounds = getBoundsInParent(
            batch.labelMaster,
            masterLayer,
            masterSampleTime
        );

        if (!masterBounds) {
            throw new Error(
                "无法读取原标题模板在取样时间处的实际视觉边界。"
            );
        }

        app.beginUndoGroup(
            "v8.2.3 原版模板最终校准"
        );

        var success = 0;
        var failed = 0;
        var firstError = null;

        try {
            // ====================================================
            // A. 先放入裁切后的 REFERENCE
            // ====================================================

            var referenceLayer =
                exportComp.layers.add(
                    batch.referenceComp
                );

            referenceLayer.name =
                batch.referenceComp.name;

            copyVisualTransformOnly(
                masterLayer,
                referenceLayer
            );

            // 先按原逻辑粗略锁到母版左上
            pinLayerTopLeft(
                referenceLayer,
                masterBounds.left,
                masterBounds.top
            );

            batch.referenceLayer =
                referenceLayer;

            // ====================================================
            // B. 所有修改后的标题先统一到 REFERENCE 同一左上
            // ====================================================

            for (
                var i = 0;
                i < batch.labelCopies.length;
                i++
            ) {
                try {
                    var layer =
                        exportComp.layers.add(
                            batch.labelCopies[i]
                        );

                    layer.name =
                        batch.labelCopies[i].name;

                    copyVisualTransformOnly(
                        masterLayer,
                        layer
                    );

                    pinLayerTopLeft(
                        layer,
                        masterBounds.left,
                        masterBounds.top
                    );

                    layer.enabled = false;

                    batch.placedLayers.push(
                        layer
                    );

                    success++;

                } catch (err) {
                    failed++;

                    if (!firstError) {
                        firstError = err;
                    }
                }
            }

            // ====================================================
            // C. 最终校准：只处理“整体残差”
            //
            // 现在五个修改标题已经彼此完美对齐。
            // 只需要让整个生成组再整体吸到原版标题模板。
            //
            // 做法：
            // 1. 暂时打开 REFERENCE
            // 2. 读取 REFERENCE 的真实视觉边界
            // 3. 与原版标题模板真实视觉边界比较
            // 4. 得到 residualDx / residualDy
            // 5. 对 REFERENCE + 所有 EXPORT 一次性整体平移
            //
            // 这样不会破坏五个新标题之间已经正确的相对对齐。
            // ====================================================

            referenceLayer.enabled = true;

            var refSampleTime = Math.min(
                settings.sampleTime,
                batch.referenceComp.duration -
                batch.referenceComp.frameDuration
            );

            if (refSampleTime < 0) {
                refSampleTime = 0;
            }

            forceRefreshComp(
                batch.referenceComp,
                refSampleTime
            );

            var referenceBounds = getBoundsInParent(
                batch.referenceComp,
                referenceLayer,
                refSampleTime
            );

            if (!referenceBounds) {
                throw new Error(
                    "无法读取 REFERENCE 对齐后的实际视觉边界。"
                );
            }

            var residualDx =
                masterBounds.left -
                referenceBounds.left;

            var residualDy =
                masterBounds.top -
                referenceBounds.top;

            // REFERENCE 自己校准
            offsetPosition(
                referenceLayer,
                residualDx,
                residualDy
            );

            // 所有修改标题使用同一个残差
            for (
                var p = 0;
                p < batch.placedLayers.length;
                p++
            ) {
                offsetPosition(
                    batch.placedLayers[p],
                    residualDx,
                    residualDy
                );
            }

            // REFERENCE 最终隐藏，只作为定位参考
            referenceLayer.enabled = false;

        } catch (outerErr) {
            failed++;

            if (!firstError) {
                firstError = outerErr;
            }

        } finally {
            app.endUndoGroup();
        }

        batch.placeDone =
            (failed === 0);

        batch.exportDone =
            false;

        updateStatus();

        try {
            exportComp.openInViewer();
        } catch (eViewer) {}

        if (failed > 0) {
            throw new Error(
                "第③步有 " +
                failed +
                " 项失败。\n\n" +
                (
                    firstError
                    ?
                    firstError.toString()
                    :
                    ""
                )
            );
        }

        if (showAlert) {
            alert(
                "③ 对齐完成。\n\n" +
                "先保持所有修改标题彼此对齐，\n" +
                "再用 REFERENCE 与原版标题模板的实际视觉边界计算最终残差，\n" +
                "整组一起做最后一次校准。\n\n" +
                "这样不会破坏五个新标题之间已经正确的对齐。"
            );
        }
    }

    function doStep4(showAlert) {
        if (!batch.placeDone || batch.placedLayers.length === 0) {
            throw new Error("请先完成第③步。");
        }

        if (!selectedFolder) {
            throw new Error("请选择输出文件夹。");
        }

        var settings = getSettings();
        var mode = rbAlpha.value ? "alpha" : "422";
        var exportComp = batch.exportComp;

        var originalStates = captureLayerStates(exportComp);

        cleanupRenderQueueForComp(exportComp);

        exportComp.duration = settings.exportDuration;
        exportComp.workAreaStart = 0;
        exportComp.workAreaDuration = settings.exportDuration;

        var success = 0, failed = 0, firstError = null;

        try {
            for (var i = 0; i < batch.placedLayers.length; i++) {
                var layer = batch.placedLayers[i];

                try {
                    showOnlyCurrentLabel(exportComp, layer);

                    var rq = app.project.renderQueue;
                    var rqItem = rq.items.add(exportComp);

                    rqItem.timeSpanStart = 0;
                    rqItem.timeSpanDuration = settings.exportDuration;

                    var om = rqItem.outputModule(1);

                    var templateName =
                        mode === "alpha"
                        ? TEMPLATE_ALPHA
                        : TEMPLATE_422;

                    if (!applyOutputTemplate(om, templateName)) {
                        throw new Error("找不到输出模块模板：" + templateName);
                    }

                    var number = ("0" + (i + 1)).slice(-2);
                    var cleanName = safeFileName(batch.texts[i]);

                    om.file = new File(
                        selectedFolder.fsName +
                        "/" +
                        number +
                        "_" +
                        cleanName +
                        ".mov"
                    );

                    rq.render();
                    success++;

                    for (var r = rq.numItems; r >= 1; r--) {
                        try {
                            if (rq.item(r).comp === exportComp) {
                                rq.item(r).remove();
                            }
                        } catch (eRQRemove) {}
                    }

                } catch (err) {
                    failed++;
                    if (!firstError) firstError = err;
                }
            }
        } finally {
            restoreLayerStates(originalStates);
        }

        batch.exportDone = (failed === 0);
        updateStatus();

        if (failed > 0) {
            throw new Error(
                "导出有 " +
                failed +
                " 条失败。\n\n" +
                (firstError ? firstError.toString() : "")
            );
        }

        if (cbOpenFolderAfter.value && selectedFolder) {
            try { selectedFolder.execute(); } catch (eOpenFolder) {}
        }

        if (showAlert) {
            alert(
                "④ 批量导出完成。\n\n成功：" +
                success +
                " 条。\n每条：" +
                settings.exportDuration +
                " 秒。"
            );
        }
    }

    btnStep1.onClick = function () {
        try { doStep1(true); }
        catch (err) { alert("第①步失败：\n\n" + err.toString()); }
    };

    btnStep2.onClick = function () {
        try { doStep2(true); }
        catch (err) { alert("第②步失败：\n\n" + err.toString()); }
    };

    btnStep3.onClick = function () {
        try { doStep3(true); }
        catch (err) { alert("第③步失败：\n\n" + err.toString()); }
    };

    btnStep4.onClick = function () {
        try { doStep4(true); }
        catch (err) { alert("第④步失败：\n\n" + err.toString()); }
    };

    btnRunAll.onClick = function () {
        try {
            doStep1(false);
            doStep2(false);
            doStep3(false);
            doStep4(false);

            alert(
                "四步流程全部完成。\n\n" +
                "文本 ✓\nREFERENCE + 标题 Auto Crop ✓\nREFERENCE 对齐 ✓\n批量导出 ✓"
            );

        } catch (err) {
            updateStatus();

            alert(
                "一键执行已停止。\n\n失败原因：\n" +
                err.toString() +
                "\n\n可以切换到“高级设置”，从对应步骤继续检查。"
            );
        }
    };

    btnCleanup.onClick = function () {
        try {
            var selection = getCurrentSelection();

            if (!confirm(
                "确认清理：\n\n" +
                "• 导出合成中的旧 EXPORT 标题层\n" +
                "• 工程里的旧标题_EXPORT合成和_REFERENCE\n" +
                "• 当前导出合成的旧渲染任务\n\n" +
                "原标题模板不会删除。"
            )) return;

            cleanupGeneratedLayers(
                selection.exportComp,
                selection.labelMaster
            );

            cleanupGeneratedComps(
                selection.labelMaster
            );

            cleanupRenderQueueForComp(
                selection.exportComp
            );

            resetBatch();

            alert("清理完成。");

        } catch (err) {
            alert("清理失败：\n\n" + err.toString());
        }
    };

    btnReset.onClick = function () {
        resetBatch();
        alert(
            "当前批次状态已重置。\n不会删除工程中的已有内容。"
        );
    };

    win.onResizing =
    win.onResize =
        function () {
            this.layout.resize();
        };

    win.center();
    win.show();

})();
