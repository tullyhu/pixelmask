import Foundation
import AVFoundation
import Vision
import CoreGraphics
import CoreImage

private let confidenceThreshold: Float = 0.4
private let maxExtrapolatedFrames = 12
private let backwardChunkSeconds: Double = 1.5
private let backwardMaxDimension: CGFloat = 768

struct Keyframe {
    let frame: Int
    let rectPixels: CGRect
}

private final class ObjectTracker {
    private var request: TrackObjectRequest
    private(set) var lastRect: CGRect
    private var velocity: CGSize = .zero
    private var extrapolated = 0

    init(seedUprightPixels: CGRect, upright: CGSize, naturalSize: CGSize, transform: CGAffineTransform) {
        let normalized = CGRect(
            x: seedUprightPixels.minX / upright.width,
            y: seedUprightPixels.minY / upright.height,
            width: seedUprightPixels.width / upright.width,
            height: seedUprightPixels.height / upright.height
        ).clampedToUnit()
        let visionRect = Geometry.uprightNormalizedToVision(
            normalized, naturalSize: naturalSize, transform: transform)
        request = TrackObjectRequest(detectedObject: DetectedObjectObservation(
            boundingBox: NormalizedRect(normalizedRect: visionRect)))
        lastRect = seedUprightPixels
    }

    func advance(on pixelBuffer: CVPixelBuffer, upright: CGSize,
                 naturalSize: CGSize, transform: CGAffineTransform) async -> CGRect {
        do {
            let result = try await request.perform(on: pixelBuffer, orientation: .up)
            return update(result: result, upright: upright, naturalSize: naturalSize, transform: transform)
        } catch {
            return lastRect
        }
    }

    func advance(on image: CGImage, upright: CGSize,
                 naturalSize: CGSize, transform: CGAffineTransform) async -> CGRect {
        do {
            let result = try await request.perform(on: image, orientation: .up)
            return update(result: result, upright: upright, naturalSize: naturalSize, transform: transform)
        } catch {
            return lastRect
        }
    }

    private func update(result: DetectedObjectObservation?, upright: CGSize,
                        naturalSize: CGSize, transform: CGAffineTransform) -> CGRect {
        if let observation = result, observation.confidence >= confidenceThreshold {
            let normalized = Geometry.visionToUprightNormalized(
                observation.boundingBox.cgRect, naturalSize: naturalSize, transform: transform)
            let pixels = CGRect(
                x: normalized.minX * upright.width,
                y: normalized.minY * upright.height,
                width: normalized.width * upright.width,
                height: normalized.height * upright.height
            )
            velocity = CGSize(width: pixels.minX - lastRect.minX, height: pixels.minY - lastRect.minY)
            lastRect = pixels
            extrapolated = 0
        } else if extrapolated < maxExtrapolatedFrames {
            lastRect = lastRect.offsetBy(dx: velocity.width, dy: velocity.height)
            extrapolated += 1
        }
        return lastRect
    }
}

private func makeReader(info: VideoInfo, fromFrame: Int, toFrame: Int) throws -> (AVAssetReader, AVAssetReaderTrackOutput) {
    let reader = try AVAssetReader(asset: info.asset)
    let output = AVAssetReaderTrackOutput(
        track: info.track,
        outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    )
    output.alwaysCopiesSampleData = false
    reader.timeRange = CMTimeRange(
        start: CMTime(seconds: Double(fromFrame) / info.fps, preferredTimescale: 600),
        end: CMTime(seconds: Double(toFrame) / info.fps, preferredTimescale: 600))
    guard reader.canAdd(output) else { throw EngineError.decodeFailed(info.asset.url.path) }
    reader.add(output)
    guard reader.startReading() else { throw EngineError.decodeFailed(info.asset.url.path) }
    return (reader, output)
}

private func trackBackward(info: VideoInfo, seed: Keyframe, toFrame: Int,
                           into dense: inout [Int: [Double]]) async throws {
    let ciContext = CIContext(options: [.cacheIntermediates: false])
    let tracker = ObjectTracker(
        seedUprightPixels: seed.rectPixels, upright: info.upright,
        naturalSize: info.naturalSize, transform: info.transform)
    var cursor = seed.frame

    while cursor > toFrame {
        if Task.isCancelled { throw CancellationError() }
        let chunkStart = max(toFrame, cursor - Int((backwardChunkSeconds * info.fps).rounded()))
        let (reader, output) = try makeReader(info: info, fromFrame: chunkStart, toFrame: cursor)
        var frames: [(Int, CGImage)] = []
        while let sampleBuffer = output.copyNextSampleBuffer() {
            let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
            let f = Int((t * info.fps).rounded())
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
            let ci = CIImage(cvPixelBuffer: pixelBuffer)
            let scale = min(1, backwardMaxDimension / max(ci.extent.width, ci.extent.height))
            let scaled = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            guard let cg = ciContext.createCGImage(scaled, from: scaled.extent) else { continue }
            frames.append((f, cg))
        }
        _ = reader
        for (f, image) in frames.reversed() {
            if Task.isCancelled { throw CancellationError() }
            guard f >= toFrame, f < seed.frame else { continue }
            let rect = await tracker.advance(
                on: image, upright: info.upright,
                naturalSize: info.naturalSize, transform: info.transform)
            dense[f] = [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)]
        }
        cursor = chunkStart
        await Task.yield()
    }
}

func denseBetween(path: String, keyframes: [Keyframe], from fromFrame: Int, to toFrame: Int) async throws -> [String: [Double]] {
    let info = try await loadVideoInfo(path: path)
    let kfs = keyframes.sorted { $0.frame < $1.frame }
    guard !kfs.isEmpty, toFrame >= fromFrame else { return [:] }

    var dense: [Int: [Double]] = [:]

    if let seed = kfs.first(where: { $0.frame >= fromFrame }), seed.frame > fromFrame {
        try await trackBackward(info: info, seed: seed, toFrame: fromFrame, into: &dense)
    }

    let (reader, output) = try makeReader(info: info, fromFrame: fromFrame, toFrame: toFrame + 1)
    var segmentIndex = -1
    var tracker: ObjectTracker?

    while let sampleBuffer = output.copyNextSampleBuffer() {
        if Task.isCancelled { reader.cancelReading(); throw CancellationError() }
        let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        let f = Int((t * info.fps).rounded())
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
        guard f >= fromFrame, f <= toFrame else { continue }
        guard let nextSegment = kfs.lastIndex(where: { $0.frame <= f }) else { continue }

        if nextSegment != segmentIndex {
            segmentIndex = nextSegment
            tracker = ObjectTracker(
                seedUprightPixels: kfs[segmentIndex].rectPixels, upright: info.upright,
                naturalSize: info.naturalSize, transform: info.transform)
        }
        guard let tracker else { continue }
        let rect = await tracker.advance(
            on: pixelBuffer, upright: info.upright,
            naturalSize: info.naturalSize, transform: info.transform)
        dense[f] = [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)]
    }

    FileHandle.standardError.write(Data(
        "[track] path=\(path) kfs=\(kfs.count) range=\(fromFrame)-\(toFrame) dense=\(dense.count)\n".utf8))
    return dense.reduce(into: [:]) { $0[String($1.key)] = $1.value }
}
