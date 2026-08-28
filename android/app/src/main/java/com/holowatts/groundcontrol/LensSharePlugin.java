package com.holowatts.groundcontrol;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import org.json.JSONObject;

@CapacitorPlugin(name = "LensShare")
public class LensSharePlugin extends Plugin {

  @PluginMethod
  public void sharePhotos(PluginCall call) {
    final String text = call.getString("text", "");
    final JSArray photos = call.getArray("photos");
    if (photos == null || photos.length() == 0) {
      call.reject("no photos");
      return;
    }

    getActivity()
        .runOnUiThread(
            () -> {
              try {
                ArrayList<Uri> uris = new ArrayList<>();
                File cacheDir = new File(getContext().getCacheDir(), "lens-share");
                if (!cacheDir.exists() && !cacheDir.mkdirs()) {
                  call.reject("cache unavailable");
                  return;
                }
                long stamp = System.currentTimeMillis();

                for (int i = 0; i < photos.length(); i++) {
                  JSONObject row = photos.getJSONObject(i);
                  String b64 = row.getString("base64");
                  String name = row.optString("name", "roof-" + i + ".jpg");
                  byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                  File out = new File(cacheDir, stamp + "-" + name);
                  try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(bytes);
                  }
                  Uri uri =
                      FileProvider.getUriForFile(
                          getContext(), getContext().getPackageName() + ".fileprovider", out);
                  uris.add(uri);
                }

                Intent intent;
                if (uris.size() == 1) {
                  intent = new Intent(Intent.ACTION_SEND);
                  intent.setType("image/jpeg");
                  intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                } else {
                  intent = new Intent(Intent.ACTION_SEND_MULTIPLE);
                  intent.setType("image/jpeg");
                  intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                }
                if (text != null && !text.isEmpty()) {
                  intent.putExtra(Intent.EXTRA_TEXT, text);
                }
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                Intent chooser = Intent.createChooser(intent, "Send to ChatGPT");
                getActivity().startActivity(chooser);

                JSObject out = new JSObject();
                out.put("ok", true);
                out.put("count", uris.size());
                call.resolve(out);
              } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
              }
            });
  }
}
