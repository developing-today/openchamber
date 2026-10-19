package com.openchamber.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;

/** Hands the web layer this phone's push seal key (see PushSealKey). */
@CapacitorPlugin(name = "PushKey")
public class PushKeyPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        result.put("key", PushSealKey.get(getContext()));
        call.resolve(result);
    }

    /**
     * Whether this build has Firebase configured. A package with no client in
     * google-services.json has no default FirebaseApp, and the push plugin's register()
     * throws there, which crashes the app. The web layer checks this before registering.
     */
    @PluginMethod
    public void pushAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", !FirebaseApp.getApps(getContext()).isEmpty());
        call.resolve(result);
    }
}
