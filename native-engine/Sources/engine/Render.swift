import Foundation
import AVFoundation
import CoreImage
import CoreGraphics
import Vision

struct RenderClip {
    let id: String
    let src: String
    let inSec: Double
    let outSec: Double
    let speed: Double
    let fps: Double
    let width: Double
    let height: Double
    let hasAudio: Bool
    let crop: CGRect?
}

struct RenderTrack {
    let clipId: String
    let effect: String
    let keyframes: [Keyframe]
    let dense: [Int: [Double]]
    let tStart: Double?
    let tEnd: Double?
}

struct RenderSegment {
    let compStart: Double
    let compEnd: Double
    let clipIndex: Int
    let clipIn: Double
    let speed: Double
    let transform: CGAffineTransform
    let upright: CGSize
}

final class RenderManager: @unchecked Sendable {
    static let shared = RenderManager()

    private struct SendableBox<T>: @unchecked Sendable {
        let value: T
    }

    private let lock = NSLock()
    private var state = "idle"
    private var progress: Double = 0
    private var error: String?
    private var outputPath: String?
    private var session: AVAssetExportSession?
    private var renderTask: Task<Void, Never>?

    func start(project: [String: Any], output: String, personSegmentation: Bool = false) throws {
        lock.lock()
        if state == "running" {
            lock.unlock()
            throw EngineError.badRequest("render already running")
        }
        state = "running"
        progress = 0
        error = nil
        outputPath = nil
        lock.unlock()

        let projectBox = SendableBox(value: project)
        renderTask = Task {
            await run(project: projectBox.value, output: output, personSegmentation: personSegmentation)
        }
    }

    func status() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return [
            "state": state,
            "progress": progress,
            "phase": state == "running" ? "encoding" : NSNull(),
            "error": error ?? NSNull(),
            "output": outputPath ?? NSNull(),
        ] as [String: Any]
    }

    func cancel() -> [String: Any] {
        lock.lock()
        let s = session
        lock.unlock()
        renderTask?.cancel()
        s?.cancelExport()
        lock.lock()
        if state == "running" {
            state = "idle"
            progress = 0
        }
        lock.unlock()
        return ["ok": s != nil]
    }

    private func setState(state: String, progress: Double? = nil, error: String? = nil, output: String? = nil) {
        lock.lock()
        self.state = state
        if let progress { self.progress = progress }
        self.error = error
        self.outputPath = output
        lock.unlock()
    }

    private func setSession(_ session: AVAssetExportSession) {
        lock.lock()
        self.session = session
        lock.unlock()
    }

    private func run(project: [String: Any], output: String, personSegmentation: Bool) async {
        do {
            let (composition, videoTrack, segments, clips, tracks, renderSize) = try await buildComposition(project: project)
            let totalDuration = segments.last?.compEnd ?? 0

            let context = RenderContext(
                segments: segments, clips: clips, tracks: tracks,
                renderSize: renderSize, totalFrames: max(totalDuration * 30, 1),
                personSegmentation: personSegmentation)
            context.onProgress = { [weak self] p in
                self?.setState(state: "running", progress: min(0.999, p))
            }
            RenderCompositorContext.shared.context = context

            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(
                start: .zero,
                duration: CMTime(seconds: totalDuration, preferredTimescale: 600))
            let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
            instruction.layerInstructions = [layerInstruction]

            let videoComposition = AVMutableVideoComposition()
            videoComposition.customVideoCompositorClass = RenderCompositor.self
            videoComposition.renderSize = renderSize
            videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
            videoComposition.instructions = [instruction]

            let outputURL = URL(fileURLWithPath: output)
            try? FileManager.default.removeItem(at: outputURL)
            guard let session = AVAssetExportSession(
                asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
                throw EngineError.decodeFailed("export session")
            }
            session.outputURL = outputURL
            session.outputFileType = .mp4
            session.videoComposition = videoComposition
            session.shouldOptimizeForNetworkUse = true
            setSession(session)

            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                session.exportAsynchronously { cont.resume() }
            }

            if Task.isCancelled || session.status == .cancelled {
                setState(state: "idle", progress: 0)
                return
            }
            if session.status == .completed {
                setState(state: "done", progress: 1, output: output)
            } else {
                let message = session.error?.localizedDescription ?? "未知错误"
                setState(state: "error", error: message)
            }
            FileHandle.standardError.write(Data(
                "[render] finished status=\(session.status.rawValue) error=\(String(describing: session.error))\n".utf8))
        } catch {
            setState(state: "error", error: error.localizedDescription)
            FileHandle.standardError.write(Data("[render] error: \(error)\n".utf8))
        }
    }

    private func buildComposition(project: [String: Any]) async throws -> (
        AVMutableComposition, AVMutableCompositionTrack, [RenderSegment], [RenderClip], [RenderTrack], CGSize
    ) {
        guard let clipDicts = project["clips"] as? [[String: Any]], !clipDicts.isEmpty else {
            throw EngineError.badRequest("project.clips 为空")
        }
        let trackDicts = project["tracks"] as? [[String: Any]] ?? []

        var clips: [RenderClip] = []
        for c in clipDicts {
            guard let src = c["src"] as? String else { throw EngineError.badRequest("clip 缺少 src") }
            var crop: CGRect? = nil
            if let cr = c["crop"] as? [String: Any] {
                crop = CGRect(x: jsonNumber(cr["x"]) ?? 0, y: jsonNumber(cr["y"]) ?? 0,
                              width: jsonNumber(cr["w"]) ?? 0, height: jsonNumber(cr["h"]) ?? 0)
            }
            clips.append(RenderClip(
                id: c["id"] as? String ?? "",
                src: src,
                inSec: jsonNumber(c["in"]) ?? 0,
                outSec: jsonNumber(c["out"]) ?? 0,
                speed: max(jsonNumber(c["speed"]) ?? 1, 0.01),
                fps: jsonNumber(c["fps"]) ?? 30,
                width: jsonNumber(c["width"]) ?? 0,
                height: jsonNumber(c["height"]) ?? 0,
                hasAudio: c["has_audio"] as? Bool ?? false,
                crop: crop))
        }

        var tracks: [RenderTrack] = []
        for t in trackDicts {
            var keyframes: [Keyframe] = []
            for k in t["keyframes"] as? [[String: Any]] ?? [] {
                keyframes.append(Keyframe(
                    frame: jsonInt(k["frame"]) ?? 0,
                    rectPixels: CGRect(x: jsonNumber(k["x"]) ?? 0, y: jsonNumber(k["y"]) ?? 0,
                                       width: jsonNumber(k["w"]) ?? 0, height: jsonNumber(k["h"]) ?? 0)))
            }
            var dense: [Int: [Double]] = [:]
            for (key, value) in t["dense"] as? [String: Any] ?? [:] {
                if let f = Int(key), let arr = value as? [Any] {
                    dense[f] = arr.compactMap { jsonNumber($0) }
                }
            }
            tracks.append(RenderTrack(
                clipId: t["clipId"] as? String ?? "",
                effect: t["effect"] as? String ?? "pixelate",
                keyframes: keyframes, dense: dense,
                tStart: jsonNumber(t["tStart"]), tEnd: jsonNumber(t["tEnd"])))
        }

        func even(_ n: Double) -> Int {
            let v = Int(n.rounded())
            return v % 2 == 0 ? v : v + 1
        }

        let first = clips[0]
        let renderSize: CGSize
        if let crop = first.crop {
            renderSize = CGSize(width: even(crop.width), height: even(crop.height))
        } else {
            renderSize = CGSize(width: even(first.width), height: even(first.height))
        }

        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw EngineError.decodeFailed("composition")
        }
        videoTrack.preferredTransform = .identity
        let audioTrack = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

        var segments: [RenderSegment] = []
        var cursor = 0.0
        for (index, clip) in clips.enumerated() {
            let info = try await loadVideoInfo(path: clip.src)
            let range = CMTimeRange(
                start: CMTime(seconds: clip.inSec, preferredTimescale: 600),
                end: CMTime(seconds: clip.outSec, preferredTimescale: 600))
            let at = CMTime(seconds: cursor, preferredTimescale: 600)
            try videoTrack.insertTimeRange(range, of: info.track, at: at)
            if clip.hasAudio, let audioTrack,
               let srcAudio = try await info.asset.loadTracks(withMediaType: .audio).first {
                try? audioTrack.insertTimeRange(range, of: srcAudio, at: at)
            } else {
                audioTrack?.insertEmptyTimeRange(range)
            }
            let outDuration = (clip.outSec - clip.inSec) / clip.speed
            if clip.speed != 1 {
                let scaled = CMTimeRange(start: at, duration: range.duration)
                let to = CMTime(seconds: outDuration, preferredTimescale: 600)
                videoTrack.scaleTimeRange(scaled, toDuration: to)
                audioTrack?.scaleTimeRange(scaled, toDuration: to)
            }
            segments.append(RenderSegment(
                compStart: cursor, compEnd: cursor + outDuration,
                clipIndex: index, clipIn: clip.inSec, speed: clip.speed,
                transform: info.transform, upright: info.upright))
            FileHandle.standardError.write(Data(
                "[render] clip\(index): in=\(clip.inSec) out=\(clip.outSec) speed=\(clip.speed) tracks=\(tracks.filter { $0.clipId == clip.id }.count)\n".utf8))
            cursor += outDuration
        }

        return (composition, videoTrack, segments, clips, tracks, renderSize)
    }
}

final class RenderContext {
    let segments: [RenderSegment]
    let clips: [RenderClip]
    let tracks: [RenderTrack]
    let renderSize: CGSize
    let totalFrames: Double
    let personSegmentation: Bool
    var onProgress: ((Double) -> Void)?
    private let lock = NSLock()
    private var framesDone: Double = 0

    init(segments: [RenderSegment], clips: [RenderClip], tracks: [RenderTrack],
         renderSize: CGSize, totalFrames: Double, personSegmentation: Bool = false) {
        self.segments = segments
        self.clips = clips
        self.tracks = tracks
        self.renderSize = renderSize
        self.totalFrames = totalFrames
        self.personSegmentation = personSegmentation
    }

    func frameRendered() {
        lock.lock()
        framesDone += 1
        let p = framesDone / totalFrames
        let cb = onProgress
        lock.unlock()
        if Int(framesDone) % 15 == 0 { cb?(p) }
    }

    func segment(at time: Double) -> RenderSegment? {
        segments.first { time >= $0.compStart && time < $0.compEnd } ?? segments.last
    }

    func activeRects(segment: RenderSegment, at sourceTime: Double) -> [(String, CGRect)] {
        let clip = clips[segment.clipIndex]
        var result: [(String, CGRect)] = []
        for track in tracks where track.clipId == clip.id {
            let s = max(clip.inSec, track.tStart ?? clip.inSec)
            let e = min(clip.outSec, track.tEnd ?? clip.outSec)
            guard sourceTime >= s, sourceTime <= e else { continue }
            let frame = Int((sourceTime * clip.fps).rounded())
            guard let rect = interpolate(track: track, frame: frame) else { continue }
            result.append((track.effect, rect))
        }
        return result
    }

    private func interpolate(track: RenderTrack, frame: Int) -> CGRect? {
        if !track.dense.isEmpty {
            let keys = track.dense.keys.sorted()
            guard let first = keys.first, let last = keys.last else { return nil }
            if frame <= first { return rectFrom(track.dense[first]) }
            if frame >= last { return rectFrom(track.dense[last]) }
            var lower = first
            for k in keys {
                if k <= frame { lower = k } else { break }
            }
            let upper = keys.first { $0 > frame } ?? last
            if lower == upper { return rectFrom(track.dense[lower]) }
            guard let a = track.dense[lower], let b = track.dense[upper], a.count == 4, b.count == 4 else { return nil }
            let r = Double(frame - lower) / Double(upper - lower)
            return CGRect(x: a[0] + (b[0] - a[0]) * r, y: a[1] + (b[1] - a[1]) * r,
                          width: a[2] + (b[2] - a[2]) * r, height: a[3] + (b[3] - a[3]) * r)
        }
        let kfs = track.keyframes.sorted { $0.frame < $1.frame }
        guard let first = kfs.first, let last = kfs.last else { return nil }
        if frame <= first.frame { return first.rectPixels }
        if frame >= last.frame { return last.rectPixels }
        var i = 0
        while i + 1 < kfs.count && kfs[i + 1].frame < frame { i += 1 }
        let a = kfs[i], b = kfs[min(i + 1, kfs.count - 1)]
        let span = Double(b.frame - a.frame)
        let r = span > 0 ? Double(frame - a.frame) / span : 0
        let ar = a.rectPixels, br = b.rectPixels
        return CGRect(x: ar.minX + (br.minX - ar.minX) * r, y: ar.minY + (br.minY - ar.minY) * r,
                      width: ar.width + (br.width - ar.width) * r,
                      height: ar.height + (br.height - ar.height) * r)
    }

    private func rectFrom(_ arr: [Double]?) -> CGRect? {
        guard let arr, arr.count == 4 else { return nil }
        return CGRect(x: arr[0], y: arr[1], width: arr[2], height: arr[3])
    }
}

final class RenderCompositorContext: @unchecked Sendable {
    static let shared = RenderCompositorContext()
    var context: RenderContext?
}

final class RenderCompositor: NSObject, AVVideoCompositing {
    private let renderQueue = DispatchQueue(label: "com.videoredactor.render", qos: .userInitiated)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private var renderContext: AVVideoCompositionRenderContext?

    var sourcePixelBufferAttributes: [String: any Sendable]? {
        [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    }

    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] {
        [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    }

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {
        renderQueue.sync { renderContext = newRenderContext }
    }

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        renderQueue.async { [weak self] in
            guard let self else { return }
            autoreleasepool { self.render(request) }
        }
    }

    func cancelAllPendingVideoCompositionRequests() {}

    private func render(_ request: AVAsynchronousVideoCompositionRequest) {
        guard let renderContext else {
            request.finish(with: NSError(domain: "VideoRedactor", code: -1))
            return
        }
        guard let context = RenderCompositorContext.shared.context,
              let trackID = request.sourceTrackIDs.first?.int32Value,
              let sourceBuffer = request.sourceFrame(byTrackID: trackID) else {
            request.finish(with: NSError(domain: "VideoRedactor", code: -2))
            return
        }

        let time = CMTimeGetSeconds(request.compositionTime)
        let renderSize = context.renderSize

        var frame: CIImage
        if let segment = context.segment(at: time) {
            let sourceTime = segment.clipIn + (time - segment.compStart) * segment.speed
            var base = CIImage(cvPixelBuffer: sourceBuffer).transformed(by: segment.transform)
            base = base.transformed(by: CGAffineTransform(translationX: -base.extent.minX, y: -base.extent.minY))

            let W = segment.upright.width
            let H = segment.upright.height
            let active = context.activeRects(segment: segment, at: sourceTime)
            var personMask: CIImage?
            if context.personSegmentation && !active.isEmpty {
                personMask = segmentPerson(in: sourceBuffer, extent: base.extent, transform: segment.transform)
            }
            for (effect, rect) in active {
                let ciRect = CGRect(
                    x: rect.minX, y: H - rect.minY - rect.height,
                    width: rect.width, height: rect.height
                ).intersection(CGRect(x: 0, y: 0, width: W, height: H)).integral
                guard ciRect.width > 1, ciRect.height > 1 else { continue }
                base = apply(effect: effect, rect: ciRect, to: base, personMask: personMask)
            }

            let clip = context.clips[segment.clipIndex]
            if let crop = clip.crop {
                let ciCrop = CGRect(
                    x: crop.minX, y: H - crop.minY - crop.height,
                    width: crop.width, height: crop.height
                ).intersection(CGRect(x: 0, y: 0, width: W, height: H))
                base = base.cropped(to: ciCrop)
            }
            frame = fit(base, into: renderSize)
        } else {
            frame = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: renderSize))
        }

        guard let destination = renderContext.newPixelBuffer() else {
            request.finish(with: NSError(domain: "VideoRedactor", code: -3))
            return
        }
        ciContext.render(frame, to: destination, bounds: CGRect(origin: .zero, size: renderSize),
                         colorSpace: CGColorSpaceCreateDeviceRGB())
        context.frameRendered()
        request.finish(withComposedVideoFrame: destination)
    }

    private func segmentPerson(in pixelBuffer: CVPixelBuffer, extent: CGRect, transform: CGAffineTransform) -> CIImage? {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .accurate
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        let orientation = Geometry.visionOrientation(from: transform)
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        guard let observation = request.results?.first as? VNPixelBufferObservation else { return nil }
        var mask = CIImage(cvPixelBuffer: observation.pixelBuffer)
        let scaleX = extent.width / mask.extent.width
        let scaleY = extent.height / mask.extent.height
        mask = mask.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
        mask = mask.applyingFilter("CIMorphologyMaximum", parameters: [kCIInputRadiusKey: 3])
        return mask.cropped(to: extent)
    }

    private func apply(effect: String, rect: CGRect, to base: CIImage, personMask: CIImage? = nil) -> CIImage {
        let clamped = base.clampedToExtent()
        let patch: CIImage
        switch effect {
        case "blur":
            let blurred = clamped.applyingGaussianBlur(sigma: max(rect.height, rect.width) / 10)
            patch = blurred.cropped(to: rect)
        case "blackbox":
            patch = CIImage(color: .black).cropped(to: rect)
        default:
            let scale = max(max(rect.width, rect.height) / 12, 4)
            patch = CIFilter(name: "CIPixellate", parameters: [
                kCIInputImageKey: clamped.cropped(to: rect),
                kCIInputScaleKey: scale,
                kCIInputCenterKey: CIVector(x: rect.midX, y: rect.midY),
            ])?.outputImage ?? clamped.cropped(to: rect)
        }
        if let personMask {
            let rectWhite = CIImage(color: .white).cropped(to: rect)
            let maskInRect = personMask.applyingFilter("CIMultiplyCompositing", parameters: [
                kCIInputBackgroundImageKey: rectWhite,
            ])
            if let blended = CIFilter(name: "CIBlendWithMask", parameters: [
                kCIInputImageKey: patch,
                kCIInputBackgroundImageKey: base,
                kCIInputMaskImageKey: maskInRect,
            ])?.outputImage {
                return blended
            }
        }
        return patch.composited(over: base)
    }

    private func fit(_ image: CIImage, into size: CGSize) -> CIImage {
        let canvas = CGRect(origin: .zero, size: size)
        let black = CIImage(color: .black).cropped(to: canvas)
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return black }
        let scale = min(size.width / extent.width, size.height / extent.height)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let dx = (size.width - extent.width * scale) / 2 - extent.minX * scale
        let dy = (size.height - extent.height * scale) / 2 - extent.minY * scale
        return scaled.transformed(by: CGAffineTransform(translationX: dx, y: dy))
            .composited(over: black)
            .cropped(to: canvas)
    }
}
