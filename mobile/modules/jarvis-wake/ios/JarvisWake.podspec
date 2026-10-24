Pod::Spec.new do |s|
  s.name           = 'JarvisWake'
  s.version        = '1.0.0'
  s.summary        = 'Wake-on-LAN für James'
  s.description    = 'Schickt das Zauberpaket, das den schlafenden Rechner weckt.'
  s.author         = ''
  s.homepage       = 'https://github.com/Nivarro-boop/James-Jarvis'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
