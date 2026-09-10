(function () {

    // AE 标注批量生成器｜稳定发布版
    // 基于 v8.2.3 最终校准逻辑


    if (!app.project) {
        alert("当前没有打开 AE 工程。");
        return;
    }

    var TEXT_LAYER_NAME = "标注";
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

    function findTextLayer(comp) {
        if (!comp) return null;
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (layer instanceof TextLayer && layer.name === TEXT_LAYER_NAME) {
                    return layer;
                }
            } catch (e) {}
        }
        return null;
    }

    function collectLabelComps() {
        var all = collectAllComps();
        var result = [];
        for (var i = 0; i < all.length; i++) {
            if (findTextLayer(all[i])) result.push(all[i]);
        }
        return result;
    }

    function getDropdownComp(dropdown, list) {
        if (!dropdown.selection) return null;
        var index = dropdown.selection.index;
        if (index < 0 || index >= list.length) return null;
        return list[index];
    }

    function setTextInComp(comp, text) {
        var layer = findTextLayer(comp);
        if (!layer) throw new Error("找不到文字层：" + TEXT_LAYER_NAME);

        var textProp = layer
            .property("ADBE Text Properties")
            .property("ADBE Text Document");

        var doc = textProp.value;
        doc.text = text;
        textProp.setValue(doc);
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

    if (labelComps.length === 0) {
        alert('没有找到包含文字层“' + TEXT_LAYER_NAME + '”的标题模板合成。');
        return;
    }

    var win = new Window(
        "palette",
        "AE 标注批量生成器",
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
        ["基础设置", "高级设置"]
    );
    viewDropdown.selection = 0;
    viewDropdown.preferredSize.width = 130;

    var commonPanel = win.add("panel", undefined, "基础设置");
    commonPanel.orientation = "column";
    commonPanel.alignChildren = ["fill", "top"];
    commonPanel.margins = 10;

    commonPanel.add("statictext", undefined, "导出合成");
    var exportDropdown = commonPanel.add("dropdownlist", undefined, []);
    exportDropdown.preferredSize.width = 470;

    for (var i = 0; i < allComps.length; i++) {
        exportDropdown.add("item", allComps[i].name);
    }
    if (exportDropdown.items.length > 0) exportDropdown.selection = 0;

    commonPanel.add("statictext", undefined, "标题模板");
    var labelDropdown = commonPanel.add("dropdownlist", undefined, []);
    labelDropdown.preferredSize.width = 470;

    for (var j = 0; j < labelComps.length; j++) {
        labelDropdown.add("item", labelComps[j].name);
    }
    if (labelDropdown.items.length > 0) labelDropdown.selection = 0;

    var textPanel = win.add("panel", undefined, "批量文字（每行一条）");
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

    var basicPanel = win.add("panel", undefined, "一键运行");
    basicPanel.orientation = "column";
    basicPanel.alignChildren = ["fill", "top"];
    basicPanel.margins = 10;

    var btnRunAll = basicPanel.add(
        "button",
        undefined,
        "一键执行四步流程"
    );
    btnRunAll.preferredSize.height = 45;

    basicPanel.add(
        "statictext",
        undefined,
        "模板根图层居中扩展并改字 → 批量Auto Crop → 批量位置对齐 → 批量导出渲染"
    );

    var basicOutputPanel = win.add("panel", undefined, "输出");
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

    var basicStatus = win.add("statictext", undefined, "状态：未开始");

    var advancedContainer = win.add("group");
    advancedContainer.orientation = "column";
    advancedContainer.alignChildren = ["fill", "top"];
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

    var btnCleanup = toolsPanel.add("button", undefined, "清理旧 EXPORT");
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

    function setView(isAdvanced) {
        advancedContainer.visible = isAdvanced;
        basicPanel.visible = !isAdvanced;
        win.layout.layout(true);
        win.layout.resize();
    }

    viewDropdown.onChange = function () {
        setView(viewDropdown.selection.index === 1);
    };

    setView(false);

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
        var exportComp = getDropdownComp(exportDropdown, allComps);
        var labelMaster = getDropdownComp(labelDropdown, labelComps);

        if (!exportComp || !labelMaster) {
            throw new Error("请先选择导出合成和标题模板。");
        }

        var usage = findUsageLayers(exportComp, labelMaster);

        if (usage.length === 0) {
            throw new Error("导出合成中没有直接使用这个标题模板。");
        }

        return {
            exportComp: exportComp,
            labelMaster: labelMaster,
            masterUsageLayer: usage[0]
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
                    texts[n]
                );

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
                "• 长标题左右都完整"
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
