/* After Effects ExtendScript (ES3)
   Batch-replace one footage layer, duplicate the nested path to a final comp,
   preserve replacement stacking order, clone the complete export graph,
   extend nested background/decorative timelines, and add each final duplicate
   to the AE render queue. The original template comps are not modified.
*/
(function (thisObj) {
    var FINAL_NAME = "视频框-最终";
    var PANEL_VERSION = "2026.10.19.1";
    var BATCH_COMMENT_TAG = "AE_BATCH_PANEL_INPUT:";
    var project = app.project;
    var importedItems = [];
    var createdComps = [];
    var undoStarted = false;

    $.global.AE_BATCH_PANEL_VERSION = PANEL_VERSION;
    function fail(message) { throw new Error(message); }
    function queueDiagnostic(message) {
        try {
            var log = new File(Folder.temp.fsName + "/ae-batch-render-range.log");
            if (log.open("a")) {
                log.writeln((new Date()).toString() + " | " + PANEL_VERSION + " | " + message);
                log.close();
            }
        } catch (ignoreDiagnostic) {}
    }
    function sourceOf(layer) { return layer instanceof AVLayer ? layer.source : null; }
    function writable(layer, action) {
        var locked = layer.locked;
        try { layer.locked = false; action(); }
        finally { layer.locked = locked; }
    }
    function framesUp(seconds, comp) {
        return Math.max(1, Math.ceil(seconds / comp.frameDuration - 0.000001)) * comp.frameDuration;
    }
    function safeName(name) {
        return name.replace(/[\\\/:*?"<>|]/g, "_").replace(/^\s+|\s+$/g, "");
    }
    function shortName(name, max) {
        return name.length > max ? name.substring(0, max) : name;
    }
    function formatBatchOutputName(base, index, versionText) {
        var cleanBase = shortName(safeName(String(base || "")), 150);
        var match = /^V([1-9]|1[0-9]|20)$/i.exec(String(versionText || ""));
        index = parseInt(index, 10);
        if (!cleanBase) fail("请填写合成命名。");
        if (!(index >= 1)) fail("合成序号无效。");
        if (!match) fail("版本号必须在 V1 到 V20 之间。");
        return shortName(cleanBase + index + "_v" + match[1], 180);
    }
    function markBatchComp(comp, file) {
        try {
            var existing = comp.comment || "";
            comp.comment = existing + (existing ? "\n" : "") + BATCH_COMMENT_TAG + file.fsName;
        } catch (ignoreBatchComment) {}
    }
    function recoveredBatchFile(comp) {
        var comment = "", index, path, lineEnd;
        try { comment = comp.comment || ""; } catch (ignoreComment) {}
        index = comment.lastIndexOf(BATCH_COMMENT_TAG);
        if (index < 0) return { name: comp.name };
        path = comment.substring(index + BATCH_COMMENT_TAG.length);
        lineEnd = path.search(/[\r\n]/);
        if (lineEnd >= 0) path = path.substring(0, lineEnd);
        return path ? new File(path) : { name: comp.name };
    }
    function uniqueCompName(base) {
        var candidate = base, n = 2, exists, i, item;
        while (true) {
            exists = false;
            for (i = 1; i <= project.numItems; i++) {
                item = project.item(i);
                if (item instanceof CompItem && item.name === candidate) { exists = true; break; }
            }
            if (!exists) return candidate;
            candidate = base + "_" + n++;
        }
    }
    function allComps() {
        var result = [], i, item;
        for (i = 1; i <= project.numItems; i++) {
            item = project.item(i);
            if (item instanceof CompItem) result.push(item);
        }
        return result;
    }
    function findPath(comp, target, visiting) {
        var key = "c" + comp.id, j, layer, src, tail;
        if (comp.id === target.id) return [];
        visiting = visiting || {};
        if (visiting[key]) return null;
        visiting[key] = true;
        for (j = 1; j <= comp.numLayers; j++) {
            layer = comp.layer(j);
            src = sourceOf(layer);
            if (src instanceof CompItem) {
                tail = findPath(src, target, visiting);
                if (tail !== null) {
                    visiting[key] = false;
                    return [{ parent: comp, layerIndex: j }].concat(tail);
                }
            }
        }
        visiting[key] = false;
        return null;
    }
    function resizeComp(comp, requestedDuration, pathLayerIndex) {
        var oldDuration = comp.duration;
        var duration = framesUp(requestedDuration, comp);
        var snapshots = [], i, layer, snap, end;
        for (i = 1; i <= comp.numLayers; i++) {
            layer = comp.layer(i);
            snapshots.push({ layer: layer, start: layer.inPoint, end: layer.outPoint });
        }
        comp.duration = duration;
        for (i = 0; i < snapshots.length; i++) {
            snap = snapshots[i];
            layer = snap.layer;
            end = snap.end;
            if (layer.index === pathLayerIndex ||
                end >= oldDuration - comp.frameDuration - 0.00001) {
                end = duration;
            } else if (end > duration) {
                end = duration;
            }
            if (snap.start >= end || Math.abs(end - snap.end) < 0.000001) continue;
            writable(layer, (function (targetLayer, targetEnd) {
                return function () { targetLayer.outPoint = targetEnd; };
            })(layer, end));
        }
        // Some AE versions reject an exact work-area end at a rounded frame
        // boundary. The render-queue span below is authoritative, so work-area
        // assignment is best-effort and must not abort the batch.
        try { comp.workAreaStart = 0; } catch (ignoreStart) {}
        try {
            comp.workAreaDuration = comp.duration;
        } catch (ignoreExactEnd) {
            try {
                comp.workAreaDuration = Math.max(comp.frameDuration,
                    comp.duration - comp.frameDuration * 0.001);
            } catch (ignoreWorkArea) {}
        }
        return duration;
    }

    // One memo per output: shared precomps stay shared inside that output,
    // but neither the template nor another output can be lengthened by it.
    function cloneExportTree(original, batchIndex, records) {
        var key = "c" + original.id, copy, record, i, layer, source, child, name;
        if (records[key]) return records[key].comp;
        copy = original.duplicate();
        createdComps.push(copy);
        copy.name = uniqueCompName(shortName(safeName(original.name + "__批次" + batchIndex), 180));
        record = { comp: copy, oldDuration: original.duration, layers: [], requiredDuration: 0 };
        records[key] = record;
        records["copy" + copy.id] = record;
        for (i = 1; i <= original.numLayers; i++) {
            layer = copy.layer(i);
            source = sourceOf(original.layer(i));
            record.layers.push({ layer: layer, end: layer.outPoint,
                sourceEnd: source instanceof CompItem && !layer.timeRemapEnabled && layer.stretch > 0
                    ? layer.startTime + source.duration * layer.stretch / 100 : null });
            if (!(source instanceof CompItem)) continue;
            child = cloneExportTree(source, batchIndex, records);
            name = layer.name;
            writable(layer, (function (target, replacement, originalName) {
                return function () { target.replaceSource(replacement, false); target.name = originalName; };
            })(layer, child, name));
        }
        return copy;
    }

    function extendExportTree(comp, records, requestedDuration, visiting) {
        var record = records["copy" + comp.id], key = "c" + comp.id;
        var i, j, layer, source, end, sourceEnd, speed, remap, sample, required;
        if (!record) fail("无法确认批次合成的来源：" + comp.name);
        visiting = visiting || {};
        if (visiting[key]) fail("合成存在循环引用：" + comp.name);

        // A shared precomp may be reached through more than one visible branch.
        // Keep the longest requested duration and never shorten it on a later pass.
        required = Math.max(comp.duration, framesUp(requestedDuration, comp));
        if (record.requiredDuration >= required - comp.frameDuration * 0.001) return;
        record.requiredDuration = required;
        visiting[key] = true;
        if (required > comp.duration + 0.000001) resizeComp(comp, required, null);

        for (i = 1; i <= comp.numLayers; i++) {
            layer = comp.layer(i);

            // "Visible" means the layer's video switch (eyeball) is enabled.
            // Every such layer that can appear in this comp must end with it,
            // even when it was intentionally or accidentally trimmed earlier.
            if (!layer.enabled || layer.inPoint >= comp.duration - comp.frameDuration * 0.001) continue;
            source = sourceOf(layer);
            if (source instanceof CompItem) {
                end = comp.duration;
                speed = layer.stretch / 100;
                if (layer.timeRemapEnabled) {
                    // Preserve authored remapping while making every nested comp long
                    // enough for all source times that the extended parent can request.
                    remap = layer.property("ADBE Time Remapping");
                    sourceEnd = source.frameDuration;
                    for (j = 0; j <= 16; j++) {
                        sample = Math.max(0, layer.inPoint) + (end - Math.max(0, layer.inPoint)) * j / 16;
                        sourceEnd = Math.max(sourceEnd, remap.valueAtTime(Math.min(sample, end - comp.frameDuration), false) + source.frameDuration);
                    }
                    for (j = 1; j <= remap.numKeys; j++) {
                        if (remap.keyTime(j) >= layer.inPoint && remap.keyTime(j) < end) sourceEnd = Math.max(sourceEnd, remap.keyValue(j) + source.frameDuration);
                    }
                } else if (speed > 0) {
                    sourceEnd = (end - layer.startTime) / speed;
                } else {
                    sourceEnd = source.duration; // Existing reverse playback stays as authored.
                }
                // AE clamps a precomp layer's out point to the source duration.
                // Extend the deepest source first, then return and extend its parent.
                extendExportTree(source, records, Math.max(source.duration, sourceEnd), visiting);
            }

            writable(layer, (function (target, newEnd) {
                return function () { target.outPoint = newEnd; };
            })(layer, comp.duration));
            if (Math.abs(layer.outPoint - comp.duration) > comp.frameDuration * 0.5) {
                fail("图层无法延长到合成结尾：" + comp.name + " / " + layer.name);
            }
        }
        visiting[key] = false;
    }
    function isShapeLayer(layer) {
        if (!layer) return false;
        try {
            if (typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer) return true;
        } catch (ignoreShapeType) {}
        return layer.matchName === "ADBE Vector Layer";
    }

    function isTextLayer(layer) {
        if (!layer) return false;
        try {
            if (typeof TextLayer !== "undefined" && layer instanceof TextLayer) return true;
        } catch (ignoreTextType) {}
        return layer.matchName === "ADBE Text Layer";
    }

    function textReplacementBounds(layer, parent, comp) {
        var current = layer, rect, points, index, point;
        var left, top, right, bottom;
        var originalTime = comp.time, sampleTime = originalTime;
        while (current) {
            if (current.threeDLayer) fail("文字替换暂不支持三维图层或三维父级，请先使用二维占位层。");
            current = current.parent;
        }
        current = parent;
        while (current) {
            if (current.threeDLayer) fail("文字替换暂不支持三维父级，请先使用二维占位层。");
            current = current.parent;
        }
        rect = layer.sourceRectAtTime(comp.time, true);
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
            var sampleStart = Math.max(0, layer.inPoint);
            var sampleEnd = Math.min(comp.duration - comp.frameDuration, layer.outPoint - comp.frameDuration);
            var largestArea = 0, candidate, candidateTime;
            for (var sampleIndex = 0; sampleIndex <= 32; sampleIndex++) {
                candidateTime = sampleStart + Math.max(0, sampleEnd - sampleStart) * sampleIndex / 32;
                candidate = layer.sourceRectAtTime(candidateTime, true);
                if (candidate && candidate.width > 0 && candidate.height > 0 && candidate.width * candidate.height > largestArea) {
                    largestArea = candidate.width * candidate.height;
                    rect = candidate;
                    sampleTime = candidateTime;
                }
            }
        }
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
            fail("文字或遮罩的可见范围为空，无法确定视频尺寸：" + layer.name);
        }
        points = [
            [rect.left, rect.top],
            [rect.left + rect.width, rect.top],
            [rect.left + rect.width, rect.top + rect.height],
            [rect.left, rect.top + rect.height]
        ];
        try {
            comp.time = sampleTime;
            for (index = 0; index < points.length; index++) {
                point = layer.sourcePointToComp(points[index]);
                if (parent) point = parent.compPointToSource(point);
                if (!point || !isFinite(point[0]) || !isFinite(point[1])) {
                    fail("无法读取文字或遮罩的位置：" + layer.name);
                }
                if (index === 0) {
                    left = right = point[0];
                    top = bottom = point[1];
                } else {
                    left = Math.min(left, point[0]);
                    right = Math.max(right, point[0]);
                    top = Math.min(top, point[1]);
                    bottom = Math.max(bottom, point[1]);
                }
            }
        } finally {
            comp.time = originalTime;
        }
        if (!(right > left) || !(bottom > top)) fail("文字或遮罩的显示尺寸为零。");
        return { center: [(left + right) / 2, (top + bottom) / 2], width: right - left, height: bottom - top };
    }

    function replaceTextLayerInDuplicate(comp, layerIndex, imported) {
        var textLayer = comp.layer(layerIndex), matteLayer = null;
        var matteType = TrackMatteType.NO_TRACK_MATTE;
        var bounds, videoLayer = null, cover;
        if (!isTextLayer(textLayer)) fail("被替换的图层不是文字层：" + textLayer.name);
        if (textLayer.threeDLayer) fail("文字替换暂不支持三维文字层，请先使用二维占位层。");
        if (textLayer.hasTrackMatte) {
            matteType = textLayer.trackMatteType;
            matteLayer = textLayer.trackMatteLayer;
            if (!matteLayer || !textLayer.setTrackMatte) {
                fail("文字层带有轨道遮罩，保留遮罩需要 AE 23.0 或更新版本。");
            }
        }
        bounds = textReplacementBounds(matteLayer || textLayer, textLayer.parent, comp);
        if (!(imported.width > 0) || !(imported.height > 0)) fail("新视频没有有效的画面尺寸。");
        cover = Math.max(bounds.width / imported.width, bounds.height / imported.height) * 100;
        try {
            videoLayer = comp.layers.add(imported);
            videoLayer.name = textLayer.name + " [视频]";
            copyLayerFlags(textLayer, videoLayer);
            videoLayer.parent = textLayer.parent;
            videoLayer.transform.anchorPoint.setValue([imported.width / 2, imported.height / 2]);
            videoLayer.transform.position.setValue(bounds.center);
            if (matteLayer) {
                videoLayer.transform.scale.setValue([cover, cover]);
                videoLayer.transform.rotation.setValue(0);
            } else {
                copyPropertyAnimation(textLayer.transform.scale, videoLayer.transform.scale);
                copyPropertyAnimation(textLayer.transform.rotation, videoLayer.transform.rotation);
            }
            copyPropertyAnimation(textLayer.transform.opacity, videoLayer.transform.opacity);
            copyEffects(textLayer, videoLayer);
            videoLayer.stretch = 100;
            videoLayer.startTime = textLayer.inPoint;
            videoLayer.inPoint = textLayer.inPoint;
            if (comp.duration < textLayer.inPoint + imported.duration) {
                resizeComp(comp, textLayer.inPoint + imported.duration, videoLayer.index);
            }
            videoLayer.outPoint = textLayer.inPoint + imported.duration;
            if (matteLayer) {
                var matteEnabled = matteLayer.enabled;
                try { videoLayer.setTrackMatte(matteLayer, matteType); }
                finally { writable(matteLayer, function () { matteLayer.enabled = matteEnabled; }); }
            }
            videoLayer.moveBefore(textLayer);
            writable(textLayer, function () {
                if (textLayer.solo) textLayer.solo = false;
                textLayer.enabled = false;
            });
        } catch (error) {
            if (videoLayer) {
                try { videoLayer.remove(); } catch (ignoreCleanup) {}
            }
            fail("文字层替换失败：" + error.message);
        }
        return videoLayer;
    }

    function copyPropertyAnimation(sourceProp, targetProp) {
        var k, t, value, inType, outType, temporalEaseIn, temporalEaseOut,
            spatialIn, spatialOut, roving, continuous, autoBezier;
        if (!sourceProp || !targetProp) return;
        try {
            if (sourceProp.expression !== undefined && sourceProp.expression !== "") {
                targetProp.expression = sourceProp.expression;
                targetProp.expressionEnabled = sourceProp.expressionEnabled;
            }
        } catch (ignoreExpression) {}

        try {
            if (sourceProp.numKeys && sourceProp.numKeys > 0) {
                for (k = 1; k <= sourceProp.numKeys; k++) {
                    t = sourceProp.keyTime(k);
                    value = sourceProp.keyValue(k);
                    targetProp.setValueAtTime(t, value);
                    try {
                        inType = sourceProp.keyInInterpolationType(k);
                        outType = sourceProp.keyOutInterpolationType(k);
                        targetProp.setInterpolationTypeAtKey(k, inType, outType);
                    } catch (ignoreInterp) {}
                    try {
                        temporalEaseIn = sourceProp.keyInTemporalEase(k);
                        temporalEaseOut = sourceProp.keyOutTemporalEase(k);
                        targetProp.setTemporalEaseAtKey(k, temporalEaseIn, temporalEaseOut);
                    } catch (ignoreEase) {}
                    try {
                        if (sourceProp.isSpatial) {
                            spatialIn = sourceProp.keyInSpatialTangent(k);
                            spatialOut = sourceProp.keyOutSpatialTangent(k);
                            targetProp.setSpatialTangentsAtKey(k, spatialIn, spatialOut);
                            targetProp.setRovingAtKey(k, sourceProp.keyRoving(k));
                            targetProp.setSpatialContinuousAtKey(k, sourceProp.keySpatialContinuous(k));
                            targetProp.setSpatialAutoBezierAtKey(k, sourceProp.keySpatialAutoBezier(k));
                        }
                    } catch (ignoreSpatial) {}
                }
            } else {
                targetProp.setValue(sourceProp.value);
            }
        } catch (ignoreValue) {
            // Some AE properties are read-only or not transferable between layer types.
        }
    }

    function copyTransform(sourceLayer, targetLayer) {
        var names = [
            "anchorPoint", "position", "scale", "rotation", "opacity",
            "orientation", "xRotation", "yRotation", "zRotation"
        ], i, sourceProp, targetProp;
        for (i = 0; i < names.length; i++) {
            try {
                sourceProp = sourceLayer.transform[names[i]];
                targetProp = targetLayer.transform[names[i]];
                copyPropertyAnimation(sourceProp, targetProp);
            } catch (ignoreTransform) {}
        }
    }

    function copyLayerFlags(sourceLayer, targetLayer) {
        var props = ["enabled", "shy", "solo", "guideLayer", "motionBlur", "threeDLayer"];
        var i, name;
        for (i = 0; i < props.length; i++) {
            name = props[i];
            try { targetLayer[name] = sourceLayer[name]; } catch (ignoreFlag) {}
        }
        try { targetLayer.blendingMode = sourceLayer.blendingMode; } catch (ignoreBlend) {}
        try { targetLayer.label = sourceLayer.label; } catch (ignoreLabel) {}
        try { targetLayer.startTime = sourceLayer.startTime; } catch (ignoreStart) {}
        try { targetLayer.inPoint = sourceLayer.inPoint; } catch (ignoreIn) {}
        try { targetLayer.outPoint = sourceLayer.outPoint; } catch (ignoreOut) {}
        try { targetLayer.stretch = sourceLayer.stretch; } catch (ignoreStretch) {}
        try { targetLayer.collapseTransformation = sourceLayer.collapseTransformation; } catch (ignoreCollapse) {}
        try { targetLayer.preserveTransparency = sourceLayer.preserveTransparency; } catch (ignoreTrans) {}
    }

    function copyEffects(sourceLayer, targetLayer) {
        var sourceEffects, targetEffects, i, sourceEffect, targetEffect, j, sourceProp, targetProp;
        try {
            sourceEffects = sourceLayer.property("ADBE Effect Parade");
            targetEffects = targetLayer.property("ADBE Effect Parade");
            if (!sourceEffects || !targetEffects) return;
            for (i = 1; i <= sourceEffects.numProperties; i++) {
                sourceEffect = sourceEffects.property(i);
                targetEffect = null;
                try { targetEffect = targetEffects.addProperty(sourceEffect.matchName); } catch (ignoreAddEffect) {}
                if (!targetEffect) continue;
                try { targetEffect.name = sourceEffect.name; } catch (ignoreEffectName) {}
                for (j = 1; j <= sourceEffect.numProperties; j++) {
                    sourceProp = sourceEffect.property(j);
                    targetProp = null;
                    try { targetProp = targetEffect.property(j); } catch (ignoreGetEffectProp) {}
                    if (!targetProp) continue;
                    copyPropertyAnimation(sourceProp, targetProp);
                }
            }
        } catch (ignoreEffects) {}
    }

    function getProp(layer, name) {
        try { return layer.transform.property(name); } catch (e) { return null; }
    }

    function setStaticValue(prop, value) {
        if (!prop) return;
        try {
            prop.setValue(value);
        } catch (e) {
            try { prop.setValueAtTime(0, value); } catch (ignore) {}
        }
    }

    function fitFootageToShapePlaceholder(shapeLayer, videoLayer, comp) {
        var bounds = textReplacementBounds(shapeLayer, videoLayer.parent, comp);
        var footage = videoLayer.source;
        if (!footage || !(footage.width > 0) || !(footage.height > 0)) {
            fail("新视频没有有效的画面尺寸。");
        }
        var cover = Math.max(bounds.width / footage.width, bounds.height / footage.height) * 100;
        videoLayer.transform.anchorPoint.setValue([footage.width / 2, footage.height / 2]);
        videoLayer.transform.position.setValue(bounds.center);
        videoLayer.transform.scale.setValue([cover, cover]);
        videoLayer.transform.rotation.setValue(0);
        copyPropertyAnimation(shapeLayer.transform.opacity, videoLayer.transform.opacity);
    }

    function replaceShapeLayerInDuplicate(comp, layerIndex, imported) {
        var shapeLayer = comp.layer(layerIndex), videoLayer, oldIndex, oldName;
        if (!isShapeLayer(shapeLayer)) fail("被替换的图层不是形状图层：" + shapeLayer.name);

        oldIndex = shapeLayer.index;
        oldName = shapeLayer.name;
        var matteLayer = null, matteType = TrackMatteType.NO_TRACK_MATTE;
        if (shapeLayer.hasTrackMatte) {
            matteLayer = shapeLayer.trackMatteLayer;
            matteType = shapeLayer.trackMatteType;
            if (!matteLayer || !shapeLayer.setTrackMatte) {
                fail("形状层带有轨道遮罩，保留遮罩需要 AE 23.0 或更新版本。");
            }
        }

        videoLayer = comp.layers.add(imported);
        writable(videoLayer, function () {
            try { videoLayer.name = oldName; } catch (ignoreName) {}
            try { videoLayer.threeDLayer = shapeLayer.threeDLayer; } catch (ignore3D) {}

            // Parent must be assigned before the comp-space -> parent-space
            // conversion, otherwise the calculated position is wrong.
            try { if (shapeLayer.parent) videoLayer.parent = shapeLayer.parent; } catch (ignoreParent) {}

            // IMPORTANT: do NOT copy ShapeLayer Position/Scale directly.
            // Fit the footage to the ShapeLayer's real displayed bounds.
            fitFootageToShapePlaceholder(shapeLayer, videoLayer, comp);

            copyLayerFlags(shapeLayer, videoLayer);
            copyEffects(shapeLayer, videoLayer);
            if (matteLayer) {
                var matteEnabled = matteLayer.enabled;
                try { videoLayer.setTrackMatte(matteLayer, matteType); }
                finally { writable(matteLayer, function () { matteLayer.enabled = matteEnabled; }); }
            }
            try { videoLayer.startTime = shapeLayer.startTime; } catch (ignoreStart) {}
            try { videoLayer.inPoint = shapeLayer.inPoint; } catch (ignoreIn) {}
            try {
                var desiredOut = shapeLayer.inPoint + imported.duration;
                videoLayer.outPoint = desiredOut;
                if (shapeLayer.outPoint > shapeLayer.inPoint && shapeLayer.outPoint < desiredOut) {
                    // Keep the template's explicit shorter outPoint only when
                    // it is intentionally shorter than the new footage.
                    videoLayer.outPoint = shapeLayer.outPoint;
                }
            } catch (ignoreOut) {}
        });

        // Occupy the placeholder's original stack slot, below its overlays.
        videoLayer.moveBefore(shapeLayer);

        // Keep the original ShapeLayer if another layer appears to use it as a
        // track matte; otherwise remove it. This avoids silently breaking mattes.
        var usedAsMatte = false, i, l;
        for (i = 1; i <= comp.numLayers; i++) {
            l = comp.layer(i);
            try {
                if (l.trackMatteType !== TrackMatteType.NO_TRACK_MATTE &&
                    l.trackMatteLayer && l.trackMatteLayer.index === shapeLayer.index) {
                    usedAsMatte = true;
                    break;
                }
            } catch (ignoreMatteCheck) {}
        }

        if (usedAsMatte) {
            try { shapeLayer.enabled = false; } catch (ignoreDisable) {}
        } else {
            try {
                shapeLayer.locked = false;
                shapeLayer.remove();
            } catch (removeError) {
                try { videoLayer.enabled = false; } catch (ignoreDisable2) {}
                fail("无法移除原形状图层「" + oldName + "」：" + removeError.message);
            }
        }

        return videoLayer;
    }

    function replaceInDuplicate(comp, layerIndex, imported) {
        var layer = comp.layer(layerIndex), replacement;
        if (isTextLayer(layer)) {
            return replaceTextLayerInDuplicate(comp, layerIndex, imported);
        }
        if (isShapeLayer(layer)) {
            replacement = replaceShapeLayerInDuplicate(comp, layerIndex, imported);
            return replacement;
        }
        if (!(layer instanceof AVLayer)) fail("被替换的图层不是 AV 图层：" + layer.name);
        if (!(sourceOf(layer) instanceof FootageItem)) {
            fail("被替换的图层不是视频素材层：" + layer.name);
        }
        writable(layer, function () {
            var originalName = layer.name;
            layer.replaceSource(imported, true);
            layer.name = originalName;
            // Preserve the template inPoint, but give the replacement its full
            // duration from that point onward.
            layer.outPoint = layer.inPoint + imported.duration;
        });
        return layer;
    }
    function importVideo(file) {
        var options = new ImportOptions(file), item;
        if (!options.canImportAs(ImportAsType.FOOTAGE)) {
            fail("文件不能作为视频素材导入：" + file.name);
        }
        options.importAs = ImportAsType.FOOTAGE;
        options.sequence = false;
        item = project.importFile(options);
        if (!(item instanceof FootageItem) || !item.hasVideo ||
            item.mainSource.isStill || !(item.duration > 0)) {
            try { item.remove(); } catch (ignore) {}
            fail("请选择有时长的视频文件，不能是静态图片或纯音频：" + file.name);
        }
        importedItems.push(item);
        return item;
    }
    function alignedRange(comp, start, end) {
        if (!isFinite(start) || !isFinite(end)) fail("视频导出范围不是有效时间。");
        var firstFrame = Math.max(0, Math.ceil(start / comp.frameDuration - 0.000001));
        var endFrame = Math.ceil(end / comp.frameDuration - 0.000001);
        if (endFrame <= firstFrame) fail("视频在所选合成中没有可导出的时间范围。");
        return { start: firstFrame * comp.frameDuration, end: endFrame * comp.frameDuration };
    }

    function setExportWorkArea(comp, start, end) {
        var range = alignedRange(comp, start, end);
        if (comp.duration < range.end) comp.duration = range.end;
        comp.workAreaStart = 0;
        comp.workAreaDuration = comp.frameDuration;
        comp.workAreaStart = range.start;
        try {
            comp.workAreaDuration = range.end - range.start;
        } catch (roundingError) {
            comp.workAreaDuration = Math.max(comp.frameDuration, range.end - range.start - comp.frameDuration * 0.001);
        }
        comp.time = range.start;
        return range;
    }

    function mapNestedRange(layer, range) {
        if (layer.timeRemapEnabled) fail("嵌套图层「" + layer.name + "」启用了时间重映射，请关闭后再批量同步时长。");
        var speed = layer.stretch / 100;
        if (!(speed > 0)) fail("嵌套图层「" + layer.name + "」使用了倒放或无效时间伸缩，无法自动同步范围。");
        var mapped = {
            start: Math.max(layer.inPoint, layer.startTime + range.start * speed),
            end: layer.startTime + range.end * speed
        };
        if (!(mapped.end > mapped.start)) fail("嵌套图层「" + layer.name + "」的入点已超出新视频范围。");
        return mapped;
    }

    function duplicateBatchPath(targetComp, targetLayerIndex, finalComp, imported, batchIndex, allowIndependent) {
        var path = findPath(finalComp, targetComp);
        var records = {};
        var childClone, parentClone, edge, layer, index, range;
        if (path === null && !allowIndependent) fail("未确认向独立的最终合成添加来源合成。");
        if (path !== null) {
            range = { start: targetComp.layer(targetLayerIndex).inPoint, end: targetComp.layer(targetLayerIndex).inPoint + imported.duration };
            for (index = path.length - 1; index >= 0; index--) {
                range = mapNestedRange(path[index].parent.layer(path[index].layerIndex), range);
            }
        }
        childClone = cloneExportTree(targetComp, batchIndex, records);
        var sourceVideoLayer = replaceInDuplicate(childClone, targetLayerIndex, imported);
        range = { start: sourceVideoLayer.inPoint, end: sourceVideoLayer.inPoint + imported.duration };
        resizeComp(childClone, range.end, sourceVideoLayer.index);
        writable(sourceVideoLayer, function () { sourceVideoLayer.outPoint = range.end; });
        setExportWorkArea(childClone, range.start, range.end);

        if (path === null) {
            parentClone = cloneExportTree(finalComp, batchIndex, records);
            var insertionStart = Math.max(0, finalComp.workAreaStart);
            var finalEnd = insertionStart + range.end - range.start;
            resizeComp(parentClone, finalEnd, null);
            layer = parentClone.layers.add(childClone);
            layer.startTime = insertionStart - range.start;
            layer.inPoint = insertionStart;
            layer.outPoint = finalEnd;
            layer.transform.anchorPoint.setValue([childClone.width / 2, childClone.height / 2]);
            layer.transform.position.setValue([parentClone.width / 2, parentClone.height / 2]);
            layer.transform.scale.setValue([100, 100]);
            range = { start: insertionStart, end: finalEnd };
            childClone = parentClone;
        } else {
            for (index = path.length - 1; index >= 0; index--) {
                edge = path[index];
                parentClone = cloneExportTree(edge.parent, batchIndex, records);
                layer = parentClone.layer(edge.layerIndex);
                range = mapNestedRange(layer, range);
                writable(layer, (function (targetLayer, sourceComp) {
                    return function () { var name = targetLayer.name; targetLayer.replaceSource(sourceComp, false); targetLayer.name = name; };
                })(layer, childClone));
                resizeComp(parentClone, range.end, layer.index);
                writable(layer, (function (targetLayer, endTime) {
                    return function () { targetLayer.outPoint = endTime; };
                })(layer, range.end));
                setExportWorkArea(parentClone, range.start, range.end);
                childClone = parentClone;
            }
        }
        extendExportTree(childClone, records, range.end);
        range = setExportWorkArea(childClone, range.start, range.end);
        return { comp: childClone, exportStart: range.start, exportEnd: range.end };
    }

    function setQueueTimeRange(item, start, end) {
        var comp = item.comp, frame = comp.frameDuration;
        var range = alignedRange(comp, start, end);
        if (range.start >= comp.duration || range.end > comp.duration + frame * 0.001) {
            fail("渲染范围超出合成：" + comp.name + "（" + range.start + " 至 " + range.end + " 秒）");
        }
        // A new queue item can inherit a full-length span. Shorten it before
        // changing the start, so intermediate writes do not overshoot the comp.
        item.timeSpanDuration = frame;
        item.timeSpanStart = range.start;
        item.timeSpanDuration = range.end - range.start;
        if (Math.abs(item.timeSpanStart - range.start) > frame * 0.001 ||
            Math.abs(item.timeSpanDuration - (range.end - range.start)) > frame * 0.001) {
            fail("AE 未保留指定的渲染范围：" + comp.name + "，请检查渲染设置。");
        }
    }

    function validateQueueTimeRange(item) {
        var comp = item.comp, frame = comp.frameDuration;
        var start = item.timeSpanStart, duration = item.timeSpanDuration;
        if (!isFinite(start) || !isFinite(duration) || start < -frame * 0.001 ||
            duration < frame * 0.999 || start >= comp.duration ||
            start + duration > comp.duration + frame * 0.001) {
            fail("渲染范围越界：" + comp.name + "（起点 " + start + " 秒，时长 " + duration +
                " 秒，合成时长 " + comp.duration + " 秒）。请在该项渲染设置中将时间范围改为合成工作区后重试。");
        }
    }

    function ensureQueueTimeRange(item, start, end) {
        var comp = item.comp, frame = comp.frameDuration;
        var range = alignedRange(comp, start, end);
        var expectedDuration = range.end - range.start;
        if (Math.abs(item.timeSpanStart - range.start) > frame * 0.001 ||
            Math.abs(item.timeSpanDuration - expectedDuration) > frame * 0.001) {
            queueDiagnostic("correct range | " + comp.name + " | current=" + item.timeSpanStart + "," +
                item.timeSpanDuration + " | expected=" + range.start + "," + expectedDuration);
            setQueueTimeRange(item, range.start, range.end);
        } else {
            queueDiagnostic("keep default range | " + comp.name + " | " + range.start + "," + expectedDuration);
        }
        validateQueueTimeRange(item);
    }

    function addToRenderQueue(comp, startTime) {
        var range = setExportWorkArea(comp, startTime, comp.duration);
        queueDiagnostic("before add | " + comp.name + " | comp=" + comp.duration + " | work=" +
            comp.workAreaStart + "," + comp.workAreaDuration + " | expected=" + range.start + "," + (range.end - range.start));
        var item = project.renderQueue.items.add(comp);
        queueDiagnostic("after add | " + comp.name + " | current=" + item.timeSpanStart + "," + item.timeSpanDuration);
        ensureQueueTimeRange(item, range.start, range.end);
        return item;
    }

    function inputStem(file) {
        var name = file.name, dot = name.lastIndexOf(".");
        if (dot > 0) name = name.substring(0, dot);
        name = shortName(safeName(name), 160);
        return name || "AE_导出";
    }

    function setQueueOutputFile(item, folder, inputFile, usedPaths) {
        var module = item.outputModule(1), original = module.file;
        var originalName = original ? original.name : "", dot = originalName.lastIndexOf(".");
        var extension = dot >= 0 ? originalName.substring(dot) : ".mov";
        var base = inputStem(inputFile), n = 1, suffix = "", output, key;
        if (extension.length > 12 || /[\\\/:*?"<>|]/.test(extension)) extension = ".mov";
        do {
            output = new File(folder.fsName + "/" + base + suffix + extension);
            key = output.fsName.toLowerCase();
            n++;
            suffix = "_" + n;
        } while (usedPaths[key] || output.exists);
        usedPaths[key] = true;
        module.file = output;
        return output;
    }

    function sendOnlyItemsToAME(items) {
        var previous = [], i, j, item, selected;
        // Send exactly the recorded batch to Media Encoder. Direct renderQueue.render()
        // blocks AE's UI thread and can crash AE 26 while extension panels are active.
        for (i = 1; i <= project.renderQueue.numItems; i++) {
            item = project.renderQueue.item(i);
            selected = false;
            for (j = 0; j < items.length; j++) {
                if (items[j] === item) { selected = true; break; }
            }
            try {
                previous.push({ item: item, render: item.render, selected: selected });
                item.render = selected;
            } catch (ignoreOldItem) {}
        }
        try {
            if (!project.renderQueue.queueInAME || project.renderQueue.canQueueInAME === false) {
                fail("Adobe Media Encoder 当前不可用，请确认已安装并完成一次启动。");
            }
            queueDiagnostic("before AME queue | items=" + items.length);
            project.renderQueue.queueInAME(true);
            queueDiagnostic("after AME queue | items=" + items.length);
        } finally {
            for (i = 0; i < previous.length; i++) {
                if (previous[i].selected) continue;
                try { previous[i].item.render = previous[i].render; } catch (ignoreRestore) {}
            }
        }
    }

    function populateCompDropdown(dropdown, comps, preferred) {
        var i, index = 0, entry;
        dropdown.removeAll();
        for (i = 0; i < comps.length; i++) {
            entry = dropdown.add("item", comps[i].name);
            entry.comp = comps[i];
            if (preferred && comps[i].id === preferred.id) index = i;
        }
        if (dropdown.items.length) dropdown.selection = index;
    }
    function populateLayerDropdown(dropdown, comp) {
        var i, layer, src, entry, selectedIndex = -1;
        dropdown.removeAll();
        if (!comp) return;
        for (i = 1; i <= comp.numLayers; i++) {
            layer = comp.layer(i);
            src = sourceOf(layer);
            if (isTextLayer(layer)) {
                entry = dropdown.add("item", i + ": " + layer.name + "  [文字图层]");
            } else if (isShapeLayer(layer)) {
                entry = dropdown.add("item", i + ": " + layer.name + "  [形状图层]");
            } else if (layer instanceof AVLayer && src instanceof FootageItem) {
                entry = dropdown.add("item", i + ": " + layer.name + "  [" + src.name + "]");
            } else {
                continue;
            }
            entry.layer = layer;
            if (comp.selectedLayers.length === 1 && comp.selectedLayers[0].index === i) {
                selectedIndex = dropdown.items.length - 1;
            }
        }
        if (dropdown.items.length) dropdown.selection = selectedIndex >= 0 ? selectedIndex : 0;
    }
    function showBatchUI(thisObj) {
        var comps = allComps(), active = project.activeItem instanceof CompItem ? project.activeItem : null;
        var defaultFinal = null, i;
        for (i = 0; i < comps.length; i++) {
            if (comps[i].name === FINAL_NAME) { defaultFinal = comps[i]; break; }
        }
        var win = thisObj instanceof Panel ? thisObj :
            new Window("palette", "视频框替换", undefined, { resizeable: true });
        win.orientation = "column";
        win.alignChildren = "fill";
        win.spacing = 5;
        win.margins = [8, 6, 8, 6];
        function labeledRow(label) {
            var row = win.add("group");
            row.orientation = "row";
            row.alignChildren = ["left", "center"];
            row.spacing = 8;
            var text = row.add("statictext", undefined, label);
            text.preferredSize.width = 82;
            return row;
        }
        var sourceRow = labeledRow("来源合成：");
        var sourceDrop = sourceRow.add("dropdownlist", undefined, []);
        sourceDrop.preferredSize.width = 360;
        populateCompDropdown(sourceDrop, comps, active);
        var layerRow = labeledRow("替换图层：");
        var layerDrop = layerRow.add("dropdownlist", undefined, []);
        layerDrop.preferredSize.width = 360;
        populateLayerDropdown(layerDrop, sourceDrop.selection ? sourceDrop.selection.comp : null);
        sourceDrop.onChange = function () {
            populateLayerDropdown(layerDrop, sourceDrop.selection ? sourceDrop.selection.comp : null);
        };
        var finalRow = labeledRow("最终合成：");
        var finalDrop = finalRow.add("dropdownlist", undefined, []);
        finalDrop.preferredSize.width = 270;
        populateCompDropdown(finalDrop, comps, defaultFinal);
        var refreshButton = finalRow.add("button", undefined, "刷新列表");
        refreshButton.preferredSize.width = 80;
        refreshButton.onClick = function () {
            var oldSource = sourceDrop.selection ? sourceDrop.selection.comp : null;
            var oldFinal = finalDrop.selection ? finalDrop.selection.comp : null;
            var currentActive = project.activeItem instanceof CompItem ? project.activeItem : null;
            var currentDefault = null, list = allComps(), k;
            for (k = 0; k < list.length; k++) {
                if (list[k].name === FINAL_NAME) { currentDefault = list[k]; break; }
            }
            populateCompDropdown(sourceDrop, list, oldSource || currentActive);
            populateLayerDropdown(layerDrop, sourceDrop.selection ? sourceDrop.selection.comp : null);
            populateCompDropdown(finalDrop, list, oldFinal || currentDefault);
        };
        win.add("statictext", undefined, "新视频顺序：");
        var filesList = win.add("listbox", undefined, [], { multiselect: false });
        filesList.preferredSize = [500, 88];
        filesList.minimumSize.height = 68;
        var fileButtons = win.add("group");
        var chooseButton = fileButtons.add("button", undefined, "添加视频");
        var removeButton = fileButtons.add("button", undefined, "移除");
        chooseButton.onClick = function () {
            var selected = File.openDialog("按顺序选择要替换的视频（可多选）", "视频文件:*.mp4;*.mov;*.m4v;*.avi;*.mxf;*.webm", true);
            var j, entry;
            if (!selected) return;
            if (!(selected instanceof Array)) selected = [selected];
            for (j = 0; j < selected.length; j++) {
                entry = filesList.add("item", selected[j].fsName);
                entry.file = selected[j];
            }
            if (filesList.items.length) filesList.selection = filesList.items.length - 1;
        };
        removeButton.onClick = function () {
            if (filesList.selection) filesList.remove(filesList.selection);
        };

        var namingRow = labeledRow("命名：");
        var namingInput = namingRow.add("edittext", undefined, "视频框");
        namingInput.preferredSize.width = 190;
        var versionLabel = namingRow.add("statictext", undefined, "版本：");
        versionLabel.preferredSize.width = 48;
        var versionDrop = namingRow.add("dropdownlist", undefined, []);
        versionDrop.preferredSize.width = 72;
        for (var versionIndex = 1; versionIndex <= 20; versionIndex++) {
            versionDrop.add("item", "V" + versionIndex);
        }
        versionDrop.selection = 0;

        var outputFolder = null;
        var outputRow = labeledRow("输出位置：");
        var outputPath = outputRow.add("edittext", undefined, "");
        outputPath.preferredSize.width = 270;
        outputPath.enabled = false;
        var outputBrowse = outputRow.add("button", undefined, "选择...");
        outputBrowse.preferredSize.width = 80;
        outputBrowse.onClick = function () {
            var selected = outputFolder ? outputFolder.selectDlg("选择本次批量渲染的输出文件夹") :
                Folder.selectDialog("选择本次批量渲染的输出文件夹");
            if (!selected) return;
            outputFolder = selected;
            outputPath.text = selected.fsName;
        };

        var note = win.add("statictext", undefined,
            "替换后可先检查合成，再渲染刚加入的队列。");
        note.preferredSize.height = 18;
        var buttons = win.add("group");
        buttons.alignment = "right";
        var run = buttons.add("button", undefined, "替换并加入队列", { name: "ok" });
        var renderNow = buttons.add("button", undefined, "渲染");
        var latestBatch = [];
        // Recover a pending batch created before this dockable panel was opened.
        // New batches carry a comment marker; old batches used "__批次" in the name.
        for (i = 1; i <= project.renderQueue.numItems; i++) {
            try {
                var pendingItem = project.renderQueue.item(i);
                var pendingComment = pendingItem.comp ? (pendingItem.comp.comment || "") : "";
                if (pendingItem.render && pendingItem.comp &&
                        (pendingComment.indexOf(BATCH_COMMENT_TAG) >= 0 || pendingItem.comp.name.indexOf("__批次") >= 0)) {
                    latestBatch.push({ item: pendingItem, file: recoveredBatchFile(pendingItem.comp) });
                }
            } catch (ignorePendingItem) {}
        }
        renderNow.enabled = latestBatch.length > 0;

        function processBatch() {
            var targetComp = sourceDrop.selection ? sourceDrop.selection.comp : null;
            var targetLayer = layerDrop.selection ? layerDrop.selection.layer : null;
            var targetLayerIndex = targetLayer ? targetLayer.index : 0;
            var finalComp = finalDrop.selection ? finalDrop.selection.comp : null;
            var files = [], j, versionText = versionDrop.selection ? versionDrop.selection.text : "V1";
            if (project.renderQueue.rendering) { alert("请在渲染完成后再生成新批次。"); return; }
            if (!targetComp || !targetLayer || !finalComp) { alert("请完整选择来源合成、替换图层和最终合成。"); return; }
            if (!(isTextLayer(targetLayer) || isShapeLayer(targetLayer) || (targetLayer instanceof AVLayer && sourceOf(targetLayer) instanceof FootageItem))) {
                alert("第 " + targetLayerIndex + " 层不是可替换的视频素材层、形状图层或文字图层。"); return;
            }
            for (j = 0; j < filesList.items.length; j++) files.push(filesList.items[j].file);
            if (!files.length) { alert("请先添加至少一个新视频，并确认列表顺序。"); return; }
            try { formatBatchOutputName(namingInput.text, 1, versionText); }
            catch (nameError) { alert(nameError.message); return; }
            var addIndependentSource = findPath(finalComp, targetComp) === null;
            if (addIndependentSource && !confirm("最终合成未引用来源合成。\n\n是否在最终合成的副本中新增一层替换后的来源合成？\n新增层将居中、按 100% 缩放，入点采用最终合成当前工作区起点；原有图层之间的顺序不变。")) return;
            var succeeded = false, batch = [];
            var results = [], imported, finalClone, queueItem, layerIndex = targetLayer.index;
            try {
                app.beginUndoGroup("批量替换视频并加入导出序列");
                undoStarted = true;
                for (j = 0; j < files.length; j++) {
                    imported = importVideo(files[j]);
                    var batchResult = duplicateBatchPath(targetComp, layerIndex, finalComp, imported, j + 1, addIndependentSource);
                    finalClone = batchResult.comp;
                    finalClone.name = uniqueCompName(formatBatchOutputName(namingInput.text, j + 1, versionText));
                    markBatchComp(finalClone, files[j]);
                    queueItem = addToRenderQueue(finalClone, batchResult.exportStart);
                    batch.push({ item: queueItem, file: files[j] });
                    results.push((j + 1) + ". " + files[j].name + "（" + imported.duration.toFixed(3) + " 秒） → " +
                        finalClone.name + "（导出入点 " + batchResult.exportStart.toFixed(3) + " 秒，时长 " +
                        queueItem.timeSpanDuration.toFixed(3) + " 秒）");
                    finalClone.openInViewer();
                }
                succeeded = true;
            } catch (error) {
                alert("未完成：" + error.message + "\n\n原始合成未被直接改写；如需撤销本次批处理，请执行一次 Ctrl+Z。");
            } finally {
                if (undoStarted) { app.endUndoGroup(); undoStarted = false; }
            }
            if (!succeeded) return;
            latestBatch = batch;
            renderNow.enabled = latestBatch.length > 0;
            alert("已完成批量替换，并加入 AE 渲染队列：" + results.length +
                " 项。\n\n现在可以进入合成检查；确认后回到本面板点击「渲染刚加入的队列」。\n\n" + results.join("\n"));
        }

        function renderLatestBatch() {
            var queueItems = [], usedPaths = {}, paths = [], i, outputFile;
            if (project.renderQueue.rendering) { alert("当前已在渲染，请等待完成。"); return; }
            if (!latestBatch.length) { alert("尚未通过本面板加入新的批次队列。"); return; }
            if (!outputFolder || !outputFolder.exists) { alert("请先选择有效的输出位置。"); return; }
            try {
                for (i = 0; i < latestBatch.length; i++) validateQueueTimeRange(latestBatch[i].item);
                for (i = 0; i < latestBatch.length; i++) {
                    outputFile = setQueueOutputFile(latestBatch[i].item, outputFolder, latestBatch[i].file, usedPaths);
                    queueItems.push(latestBatch[i].item);
                    paths.push(outputFile.fsName);
                }
                sendOnlyItemsToAME(queueItems);
                alert("已把刚才加入的队列发送到 Adobe Media Encoder 并开始渲染：" +
                    queueItems.length + " 项。\n\nAE 可以继续使用。\n\n" + paths.join("\n"));
            } catch (renderError) {
                alert("未能开始安全渲染：" + renderError.message +
                    "\n\n没有重新替换，也没有再次调用 AE 的阻塞渲染。");
            }
        }
        run.onClick = processBatch;
        renderNow.onClick = renderLatestBatch;
        win.onResizing = win.onResize = function () { this.layout.resize(); };
        if (win instanceof Window) {
            win.minimumSize = [500, 330];
            win.preferredSize = [620, 390];
        }
        win.layout.layout(true);
        if (win instanceof Window) {
            win.center();
            win.show();
        } else {
            win.layout.resize();
        }
    }
    if (!project) { alert("请先打开 AE 项目。"); return; }
    showBatchUI(thisObj);
})(this);





