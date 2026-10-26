import org.mozilla.javascript.*;
import org.mozilla.javascript.tools.shell.Global;
import java.nio.file.*;
import java.util.*;

// Minimal Rhino launcher with CT-like settings (ES6, optimisation 9) and CommonJS require.
public class RhinoRun {
    public static void main(String[] args) throws Exception {
        Context cx = Context.enter();
        try {
            cx.setLanguageVersion(200);
            cx.setOptimizationLevel(9);
            Global global = new Global(cx);
            Path root = Paths.get(args[0]).toAbsolutePath();
            global.installRequire(cx, List.of(root.toUri().toString()), false);
            String src = Files.readString(Paths.get(args[1]));
            try {
                cx.evaluateString(global, src, args[1], 1, null);
            } catch (RhinoException e) {
                System.out.println("FAIL: " + e.details() + "\n" + e.getScriptStackTrace());
                System.exit(1);
            } catch (Throwable t) {
                System.out.println("FAIL (java): " + t);
                for (StackTraceElement el : t.getStackTrace()) System.out.println("  " + el);
                System.exit(1);
            }
        } finally {
            Context.exit();
        }
    }
}
