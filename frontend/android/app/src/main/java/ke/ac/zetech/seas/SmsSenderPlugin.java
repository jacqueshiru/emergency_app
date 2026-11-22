package ke.ac.zetech.seas;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.telephony.SmsManager;
import android.telephony.SmsMessage;
import android.telephony.TelephonyManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Sends SMS from the phone's own SIM (the user's SOS texts) and reports the result.
 *
 * JS API (see frontend/src/services/smsSender.ts):
 *   isAvailable()                      -> { available, reason? }
 *   checkPermissions()/requestPermissions({permissions:['sms']}) -> { sms: 'granted' | ... }
 *   send({ id, to, message })          -> { id, status: 'sent' | 'failed' | 'unknown', error? }
 *   event "smsDelivery"                -> { id, status: 'delivered' | 'failed' }  (carrier report, may never arrive)
 *
 * Every message gets its own PendingIntents (unique request codes) so results of different
 * messages can never be mixed up, and the receiver is registered NOT_EXPORTED (required on Android 14+).
 */
@CapacitorPlugin(
    name = "SmsSender",
    permissions = { @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS }) }
)
public class SmsSenderPlugin extends Plugin {

    private static final String ACTION_SENT = "ke.ac.zetech.seas.SMS_SENT";
    private static final String ACTION_DELIVERED = "ke.ac.zetech.seas.SMS_DELIVERED";
    private static final long SENT_TIMEOUT_MS = 20_000L;
    private static final int PICK_CONTACT_REQUEST = 7411;

    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicInteger requestCodes = new AtomicInteger(1);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private BroadcastReceiver receiver;

    private static SmsSenderPlugin instance;

    /** State of one outgoing message (which may be split into several SMS parts). */
    private static class Pending {
        final String id;
        final int parts;
        final PluginCall call;
        int sentDone = 0;
        int sentOk = 0;
        int deliveredDone = 0;
        int deliveredOk = 0;
        boolean sentReported = false;
        String error = null;
        Runnable timeout = null;

        Pending(String id, int parts, PluginCall call) {
            this.id = id;
            this.parts = parts;
            this.call = call;
        }
    }

    @Override
    public void load() {
        instance = this;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                handleResult(intent, getResultCode());
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_SENT);
        filter.addAction(ACTION_DELIVERED);
        ContextCompat.registerReceiver(getContext(), receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try {
                getContext().unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // already unregistered
            }
            receiver = null;
        }
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        boolean telephony = pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY);
        TelephonyManager tm = (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
        boolean simReady = tm != null && tm.getSimState() == TelephonyManager.SIM_STATE_READY;

        JSObject ret = new JSObject();
        ret.put("available", telephony && simReady);
        if (!telephony) {
            ret.put("reason", "This device cannot send SMS");
        } else if (!simReady) {
            ret.put("reason", "No SIM card is ready");
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void send(PluginCall call) {
        String id = call.getString("id");
        String to = call.getString("to");
        String message = call.getString("message");
        if (id == null || id.isEmpty() || to == null || to.isEmpty() || message == null || message.isEmpty()) {
            call.reject("id, to and message are required");
            return;
        }
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("SMS permission not granted", "PERMISSION_DENIED");
            return;
        }

        SmsManager manager = smsManager();
        if (manager == null) {
            call.reject("SMS is not available on this device");
            return;
        }

        ArrayList<String> parts = manager.divideMessage(message);
        int total = parts.size();
        Pending p = new Pending(id, total, call);
        pending.put(id, p);
        getBridge().saveCall(call); // keep the call open: it is resolved later from the receiver

        ArrayList<PendingIntent> sentIntents = new ArrayList<>(total);
        ArrayList<PendingIntent> deliveredIntents = new ArrayList<>(total);
        for (int i = 0; i < total; i++) {
            sentIntents.add(resultIntent(ACTION_SENT, id, i));
            deliveredIntents.add(resultIntent(ACTION_DELIVERED, id, i));
        }

        p.timeout = () -> finishSent(p, "unknown", "No result from the phone within 20 seconds");
        handler.postDelayed(p.timeout, SENT_TIMEOUT_MS);

        try {
            if (total == 1) {
                manager.sendTextMessage(to, null, parts.get(0), sentIntents.get(0), deliveredIntents.get(0));
            } else {
                manager.sendMultipartTextMessage(to, null, parts, sentIntents, deliveredIntents);
            }
        } catch (Exception e) {
            finishSent(p, "failed", "Could not send: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private SmsManager smsManager() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return getContext().getSystemService(SmsManager.class); // default SMS SIM
        }
        return SmsManager.getDefault();
    }

    /** One PendingIntent per message part; unique request code, explicit package, immutable. */
    private PendingIntent resultIntent(String action, String id, int part) {
        Intent intent = new Intent(action);
        intent.setPackage(getContext().getPackageName());
        intent.putExtra("id", id);
        intent.putExtra("part", part);
        return PendingIntent.getBroadcast(
            getContext(),
            requestCodes.getAndIncrement(),
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    private void handleResult(Intent intent, int resultCode) {
        String action = intent.getAction();
        String id = intent.getStringExtra("id");
        if (action == null || id == null) return;
        Pending p = pending.get(id);
        if (p == null) return;

        synchronized (p) {
            if (ACTION_SENT.equals(action)) {
                p.sentDone++;
                if (resultCode == Activity.RESULT_OK) {
                    p.sentOk++;
                } else if (p.error == null) {
                    p.error = describe(resultCode);
                }
                if (p.sentDone >= p.parts) {
                    finishSent(p, p.sentOk >= p.parts ? "sent" : "failed", p.error);
                }
            } else if (ACTION_DELIVERED.equals(action)) {
                // The result code is RESULT_OK for ANY status report, including "failed". The truth is
                // the TP-Status inside the report's PDU: 0 = delivered, 0x40+ = permanent failure,
                // anything in between = still trying / forwarded but unconfirmed (not a final answer, so
                // the contact stays "sent" rather than being wrongly shown as delivered or failed).
                int tpStatus = deliveryStatus(intent);
                if (tpStatus > 0 && tpStatus < 0x40) {
                    return;
                }
                p.deliveredDone++;
                boolean deliveredOk = tpStatus >= 0 ? tpStatus == 0 : resultCode == Activity.RESULT_OK;
                if (deliveredOk) {
                    p.deliveredOk++;
                }
                if (p.deliveredDone >= p.parts) {
                    JSObject event = new JSObject();
                    event.put("id", id);
                    event.put("status", p.deliveredOk >= p.parts ? "delivered" : "failed");
                    notifyListeners("smsDelivery", event);
                    pending.remove(id);
                }
            }
        }
    }

    /** TP-Status of a delivery report, or -1 when the report carries no readable PDU. */
    @SuppressWarnings("deprecation")
    private static int deliveryStatus(Intent intent) {
        try {
            byte[] pdu = intent.getByteArrayExtra("pdu");
            if (pdu == null) return -1;
            String format = intent.getStringExtra("format");
            SmsMessage message = format != null
                ? SmsMessage.createFromPdu(pdu, format)
                : SmsMessage.createFromPdu(pdu);
            return message == null ? -1 : message.getStatus();
        } catch (Exception e) {
            return -1;
        }
    }

    private void finishSent(Pending p, String status, String error) {
        synchronized (p) {
            if (p.sentReported) return;
            p.sentReported = true;
            if (p.timeout != null) handler.removeCallbacks(p.timeout);

            JSObject ret = new JSObject();
            ret.put("id", p.id);
            ret.put("status", status);
            if (error != null) ret.put("error", error);
            p.call.resolve(ret);
            getBridge().releaseCall(p.call);

            // A failed send will never produce a delivery report.
            if ("failed".equals(status)) pending.remove(p.id);
        }
    }

    private static String describe(int resultCode) {
        switch (resultCode) {
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "No mobile service";
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "Airplane mode is on or the radio is off";
            case SmsManager.RESULT_ERROR_NULL_PDU:
                return "Invalid message";
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE:
                return "The phone could not send the SMS";
            default:
                return "SMS error " + resultCode;
        }
    }

    public static void notifyVolumeSos() {
        if (instance != null) {
            JSObject event = new JSObject();
            event.put("timestamp", System.currentTimeMillis());
            instance.notifyListeners("volumeSos", event);
        }
    }

    @PluginMethod
    public void isAccessibilityEnabled(PluginCall call) {
        android.text.TextUtils.SimpleStringSplitter splitter = new android.text.TextUtils.SimpleStringSplitter(':');
        String enabledServices = android.provider.Settings.Secure.getString(
            getContext().getContentResolver(),
            android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        boolean enabled = false;
        if (enabledServices != null) {
            splitter.setString(enabledServices);
            while (splitter.hasNext()) {
                android.content.ComponentName component = android.content.ComponentName.unflattenFromString(splitter.next());
                if (component != null && component.getPackageName().equals(getContext().getPackageName())
                        && component.getClassName().equals(SosVolumeAccessibilityService.class.getName())) {
                    enabled = true;
                    break;
                }
            }
        }
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent intent = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void pickContact(PluginCall call) {
        getBridge().saveCall(call);
        Intent intent = new Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivityForResult(call, intent, PICK_CONTACT_REQUEST);
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_CONTACT_REQUEST) {
            super.handleOnActivityResult(requestCode, resultCode, data);
            return;
        }
        PluginCall call = getSavedCall();
        if (call == null) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No contact selected");
            return;
        }
        String[] projection = new String[] {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER
        };
        Cursor cursor = getContext().getContentResolver().query(data.getData(), projection, null, null, null);
        if (cursor != null) {
            try {
                if (cursor.moveToFirst()) {
                    int nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                    int phoneIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                    String name = nameIndex >= 0 ? cursor.getString(nameIndex) : "";
                    String phone = phoneIndex >= 0 ? cursor.getString(phoneIndex) : "";
                    phone = phone.replaceAll("\\s+", "").replaceAll("-", "");
                    if (!phone.isEmpty()) {
                        JSObject result = new JSObject();
                        result.put("name", name);
                        result.put("phoneNumber", phone);
                        call.resolve(result);
                        return;
                    }
                }
            } finally {
                cursor.close();
            }
        }
        call.reject("Selected contact has no phone number");
    }

    @PluginMethod
    public void dial(PluginCall call) {
        String number = call.getString("number");
        if (number == null || number.isEmpty()) {
            call.reject("Emergency number is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSObject result = new JSObject();
        result.put("opened", true);
        call.resolve(result);
    }
}
