# Shared phone notice evidence

Storybook source fixture, not a live phone connection.
Node 24.18.0 on GTR; existing Chromium cache.
Desktop light/dark and 390px mobile render without clipping.
One authorized app renders no notice; duplicate IDs render three distinct names.
Keyboard Enter on Keep sharing dismisses the notice through the host callback.
The original video runs at 1x.
Before/after images show the dismissal interaction.
A mutation that removed duplicate filtering failed with four rendered names; restored source passes.
Phone switching, provider delivery, and dedicated-number purchasing remain outside this UI proof.

Independent review found a mismatched primary foreground fallback. Both primary colors now follow the host semantic pair. Rendered light and dark button contrast is 7.41:1 (minimum 4.5:1); the probe fails below that threshold. The refreshed video retains 2.5 seconds before and after keyboard dismissal at original speed.
