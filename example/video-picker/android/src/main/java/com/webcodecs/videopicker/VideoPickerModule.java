package com.webcodecs.videopicker;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

// One video from the gallery or files, copied to the cache folder so the app
// can read it by path.
public class VideoPickerModule extends ReactContextBaseJavaModule implements ActivityEventListener {
  private static final int REQUEST = 0x7669; // "vi"
  private Promise pending;

  VideoPickerModule(ReactApplicationContext context) {
    super(context);
    context.addActivityEventListener(this);
  }

  @NonNull
  @Override
  public String getName() {
    return "VideoPicker";
  }

  @ReactMethod
  public void pick(Promise promise) {
    Activity activity = getCurrentActivity();
    if (activity == null) {
      promise.reject("activity", "No activity to open the picker from");
      return;
    }
    if (pending != null) {
      promise.reject("busy", "A picker is already open");
      return;
    }
    pending = promise;
    Intent intent = new Intent(Intent.ACTION_GET_CONTENT)
        .setType("video/*")
        .addCategory(Intent.CATEGORY_OPENABLE);
    activity.startActivityForResult(intent, REQUEST);
  }

  @Override
  public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
    if (requestCode != REQUEST || pending == null) {
      return;
    }
    Promise promise = pending;
    pending = null;
    Uri uri = data != null ? data.getData() : null;
    if (resultCode != Activity.RESULT_OK || uri == null) {
      promise.resolve(null);
      return;
    }
    // A long video takes a moment to copy: not on the UI thread.
    new Thread(() -> copy(uri, promise)).start();
  }

  private void copy(Uri uri, Promise promise) {
    ReactApplicationContext context = getReactApplicationContext();
    String name = displayName(uri);
    File folder = new File(context.getCacheDir(), "picked");
    File[] old = folder.listFiles();
    if (old != null) {
      for (File file : old) {
        file.delete();
      }
    }
    folder.mkdirs();
    File copy = new File(folder, name);
    try (InputStream in = context.getContentResolver().openInputStream(uri);
         OutputStream out = new FileOutputStream(copy)) {
      if (in == null) {
        throw new IllegalStateException("Could not open " + uri);
      }
      byte[] buffer = new byte[1 << 20];
      int n;
      while ((n = in.read(buffer)) > 0) {
        out.write(buffer, 0, n);
      }
    } catch (Exception e) {
      promise.reject("copy", e.getMessage(), e);
      return;
    }
    WritableMap result = Arguments.createMap();
    result.putString("name", name);
    result.putString("path", copy.getAbsolutePath());
    result.putDouble("size", copy.length());
    promise.resolve(result);
  }

  private String displayName(Uri uri) {
    try (Cursor cursor = getReactApplicationContext().getContentResolver()
        .query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
        return new File(cursor.getString(0)).getName();
      }
    } catch (Exception ignored) {
      // Fall through to a plain name.
    }
    return "video.mp4";
  }

  @Override
  public void onNewIntent(Intent intent) {}
}
