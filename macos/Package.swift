// swift-tools-version:5.9
// The Caprock macOS app (spike). Builds with the Command Line Tools alone:
// `swift build`, then scripts/bundle.sh wraps the binary into Caprock.app.
import PackageDescription

let package = Package(
    name: "CaprockMac",
    platforms: [.macOS(.v13)],
    dependencies: [
        // 1.18.0 is the last release whose manifest builds with Swift 5.9/5.10;
        // 1.19+ needs tools 6.0.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.18.0"),
    ],
    targets: [
        .executableTarget(
            name: "CaprockMac",
            dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")]
        ),
    ]
)
