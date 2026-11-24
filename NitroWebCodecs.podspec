require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NitroWebCodecs"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/andreialecu/react-native-webcodecs"
  s.license      = package["license"]
  s.authors      = "Andrei Alecu"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/andreialecu/react-native-webcodecs.git", :tag => "#{s.version}" }

  s.source_files = ["ios/**/*.{swift}", "ios/**/*.{m,mm}"]
  s.frameworks   = ["VideoToolbox", "CoreMedia", "CoreVideo", "IOSurface", "Metal", "AudioToolbox", "UIKit"]

  load 'nitrogen/generated/ios/NitroWebCodecs+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
