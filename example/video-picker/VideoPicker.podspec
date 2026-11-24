# The example app's own video picker: PHPicker, nothing else. Linked from
# ../react-native.config.js.
Pod::Spec.new do |s|
  s.name         = "VideoPicker"
  s.version      = "1.0.0"
  s.summary      = "Picks one video from the photo library"
  s.homepage     = "https://github.com/andreialecu/react-native-webcodecs"
  s.license      = "MIT"
  s.authors      = "Andrei Alecu"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/andreialecu/react-native-webcodecs.git" }
  s.source_files = "ios/**/*.{h,m}"
  s.frameworks   = ["PhotosUI", "UniformTypeIdentifiers"]
  s.dependency "React-Core"
end
