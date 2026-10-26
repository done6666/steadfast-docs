# Task 2: Second payment provider

Add a second payment provider named `acme` behind the existing provider port.

Create `packages/provider/acme.js`, register it in `packages/provider/index.js`, and add a test that selects it by name. The adapter must follow the project's outbound HTTP rule. Do not add runtime dependencies.
