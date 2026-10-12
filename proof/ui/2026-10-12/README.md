# Studio generation settings preview

Storybook source: `Studio/StudioComposer / Video lane` on branch `feat/studio-generation-settings`, using the fixture Seedance 2.0 catalog. These captures show the package component before Creative adoption.

| View | Capture | Checked interaction |
| --- | --- | --- |
| 1440 px, agent light | [Open settings](studio-settings-1440-light.png) | Aspect, Duration, Audio defaults appear; Resolution is under More. |
| 390 px, agent light | [Open settings](studio-settings-390-light.png) | The 320 px panel stays inside the viewport; the short trigger leaves the model picker visible before opening. |
| 390 px, agent dark | [Selected duration](studio-settings-390-dark-selected.png) | Choosing 15s updates the setting row and the accessible trigger summary. |

Playwright measured the Seedance duration list at 256 px high with 429 px of scroll content and 13 radio choices at both 1440 and 390 px. Selecting 15s and pressing ArrowDown from Auto changed the current value through the native radio controls. Browser `pageerror` count was zero. The component test checked that Escape returns focus to the settings trigger. Production verification remains the Creative consumer's responsibility after it installs the released package.
