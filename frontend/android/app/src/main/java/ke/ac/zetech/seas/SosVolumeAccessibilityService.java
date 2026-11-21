package ke.ac.zetech.seas;

import android.accessibilityservice.AccessibilityService;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/** Optional system accessibility binding that detects volume presses outside the app. */
public class SosVolumeAccessibilityService extends AccessibilityService {
    private int presses;
    private long lastPress;

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) { }

    @Override
    public void onInterrupt() { }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        if (event.getAction() == KeyEvent.ACTION_DOWN
                && event.getRepeatCount() == 0
                && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            long now = System.currentTimeMillis();
            if (now - lastPress > 2200) presses = 0;
            presses++;
            lastPress = now;
            if (presses >= 3) {
                presses = 0;
                SmsSenderPlugin.notifyVolumeSos();
            }
            return true;
        }
        return false;
    }
}
