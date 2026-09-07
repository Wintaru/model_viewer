# Security

## Reporting a problem

Report a security problem privately, through GitHub's advisory form:

<https://github.com/Wintaru/model_viewer/security/advisories/new>

Do not open a public issue. Do not attach a CAD file. Describe the file, and
say which program wrote it. A maintainer will ask if more is needed.

This is a small project with no service behind it and no paid support. Expect
a first reply within about two weeks.

## What matters most in this library

This library parses untrusted binary files, in the browser, in the user's own
tab. That is the whole threat model, and these are the reports worth sending:

- **A file that crashes the tab, or hangs it.** A decoder that never returns,
  or that allocates without limit, denies service to the page that embeds it.
  A malformed file must produce a diagnostic, not a hang.
- **A file that reads outside its own buffer**, or that makes a decoder
  produce a wrong result quietly instead of reporting a failure.
- **A decompression bomb.** The SolidWorks container is deflate. A small file
  can declare a very large payload.
- **Anything that sends file bytes off the machine.** This library converts
  every file in the browser, and uploads nothing. A path that breaks that
  promise is the most serious report this project can receive.

## What is not a vulnerability here

- **A file that fails to open.** That is a bug, and the bug report template is
  the right place. The library reports a failure through `model.diagnostics`
  rather than throwing.
- **Plain text inside a CAD file.** SolidWorks stores folder paths, user names,
  and part numbers unencrypted. This library reads such a file, it does not
  create the condition. `README.md` records it under "Known limits", so a
  caller can treat a decoded file with the same care as the original.
- **A very large assembly exhausting browser memory.** A known limit, recorded
  in `README.md`, not a defect.

## Supported versions

The newest release only. This project has one maintainer, and it does not
carry patches back to older versions.

## Dependencies

Geometry for STEP and IGES comes from `occt-import-js`, which carries a
compiled build of Open CASCADE Technology. A defect in that decoder belongs to
its own project. Report it at
<https://github.com/kovacsv/occt-import-js>, and please also open an issue
here so this project can pin or update.
