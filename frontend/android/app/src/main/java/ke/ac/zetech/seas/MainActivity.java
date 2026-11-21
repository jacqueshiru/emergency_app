package ke.ac.zetech.seas;

import android.os.Bundle;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int volumePresses;
    private long lastVolumePress;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate().
        registerPlugin(SmsSenderPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            if (event.getRepeatCount() == 0) {
                long now = System.currentTimeMillis();
                if (now - lastVolumePress > 2200) volumePresses = 0;
                volumePresses++;
                lastVolumePress = now;
                if (volumePresses >= 3) {
                    volumePresses = 0;
                    SmsSenderPlugin.notifyVolumeSos();
                    return true;
                }
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
