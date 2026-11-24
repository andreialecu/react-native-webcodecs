#import <PhotosUI/PhotosUI.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// One video from the photo library, as recorded (an iPhone's HEVC stays
// HEVC), copied to the caches folder so the app can read it by path.
@interface VideoPicker : NSObject <RCTBridgeModule, PHPickerViewControllerDelegate>
@end

@implementation VideoPicker {
  RCTPromiseResolveBlock _resolve;
  RCTPromiseRejectBlock _reject;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (dispatch_queue_t)methodQueue {
  return dispatch_get_main_queue();
}

RCT_EXPORT_METHOD(pick:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_resolve) {
    reject(@"busy", @"A picker is already open", nil);
    return;
  }
  PHPickerConfiguration *config = [PHPickerConfiguration new];
  config.filter = [PHPickerFilter videosFilter];
  config.selectionLimit = 1;
  config.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;
  PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:config];
  picker.delegate = self;
  _resolve = resolve;
  _reject = reject;
  [RCTPresentedViewController() presentViewController:picker animated:YES completion:nil];
}

- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  RCTPromiseResolveBlock resolve = _resolve;
  RCTPromiseRejectBlock reject = _reject;
  _resolve = nil;
  _reject = nil;
  NSItemProvider *provider = results.firstObject.itemProvider;
  if (!provider) {
    resolve([NSNull null]);
    return;
  }
  // The file is only there during the callback: copy it out.
  [provider loadFileRepresentationForTypeIdentifier:UTTypeMovie.identifier
                                  completionHandler:^(NSURL *url, NSError *error) {
    if (!url) {
      reject(@"load", error.localizedDescription ?: @"Could not read the video", error);
      return;
    }
    NSFileManager *files = NSFileManager.defaultManager;
    NSURL *caches = [files URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *folder = [caches URLByAppendingPathComponent:@"picked"];
    [files removeItemAtURL:folder error:nil];
    [files createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *copy = [folder URLByAppendingPathComponent:url.lastPathComponent];
    NSError *copyError;
    if (![files copyItemAtURL:url toURL:copy error:&copyError]) {
      reject(@"copy", copyError.localizedDescription, copyError);
      return;
    }
    NSNumber *size = [files attributesOfItemAtPath:copy.path error:nil][NSFileSize] ?: @0;
    resolve(@{@"name": url.lastPathComponent, @"path": copy.path, @"size": size});
  }];
}

@end
