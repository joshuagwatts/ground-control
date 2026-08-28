package com.holowatts.groundcontrol;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(LensSharePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
