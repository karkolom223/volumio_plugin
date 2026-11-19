#!/bin/bash

echo "Uninstalling track_cleaner_ui: taking the delete icon out of the Volumio interface"

# safety net: the plugin removes its own patch when it is stopped, this only repeats it
for d in /volumio/http/www /volumio/http/www3 /volumio/http/www4; do
  if [ -f "$d/index.html" ]; then
    sed -i '/<!-- track_cleaner_ui:begin -->/,/<!-- track_cleaner_ui:end -->/d' "$d/index.html" 2>/dev/null || true
    rm -f "$d/track_cleaner_ui.js" "$d/track_cleaner_ui.json" 2>/dev/null || true
  fi
done

# required to end the plugin uninstall
echo "pluginuninstallend"
