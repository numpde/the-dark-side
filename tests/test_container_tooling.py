import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ContainerToolingContractTest(unittest.TestCase):
    def test_public_npm_scripts_route_through_container_wrapper(self):
        package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = package_json["scripts"]

        for script_name, command in scripts.items():
            with self.subTest(script=script_name):
                self.assertTrue(
                    command.startswith("./scripts/dev-container.sh "),
                    f"{script_name} bypasses the locked container wrapper: {command}",
                )

    def test_runtime_dispatcher_refuses_host_execution(self):
        command_script = (ROOT / "scripts" / "dev-command.sh").read_text(encoding="utf-8")

        self.assertIn('DARK_SIDE_IN_CONTAINER:-}" != "1"', command_script)
        self.assertIn("dev/test commands run only inside the locked dev container", command_script)
        self.assertIn("node --input-type=module --check", command_script)

    def test_container_wrapper_keeps_check_runs_locked_down(self):
        wrapper = (ROOT / "scripts" / "dev-container.sh").read_text(encoding="utf-8")

        required_fragments = [
            "--cap-drop ALL",
            "--security-opt no-new-privileges:true",
            "--read-only",
            "--pids-limit",
            "--memory",
            "--network none",
            "--allow-network",
            "--tmpfs /tmp:rw,nosuid,nodev",
        ]
        for fragment in required_fragments:
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, wrapper)

    def test_check_image_does_not_keep_package_managers(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn("AS the_dark_side_check", dockerfile)
        for package_manager_path in [
            "/usr/local/bin/npm",
            "/usr/local/bin/npx",
            "/usr/local/bin/corepack",
            "/usr/bin/npm",
            "/usr/bin/npx",
            "/usr/bin/corepack",
        ]:
            with self.subTest(path=package_manager_path):
                self.assertIn(package_manager_path, dockerfile)

    def test_playwright_web_server_uses_in_container_dispatcher(self):
        config = (ROOT / "playwright.config.mjs").read_text(encoding="utf-8")

        self.assertIn("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", config)
        self.assertIn("scripts/dev-command.sh preview:web", config)
        self.assertNotIn("npm run preview:web", config)

    def test_leaflet_runtime_assets_are_vendored(self):
        for html_name in ("index.html", "editor.html"):
            html = (ROOT / "web" / html_name).read_text(encoding="utf-8")
            with self.subTest(html=html_name):
                self.assertIn("./vendor/leaflet/leaflet.css", html)
                self.assertIn("./vendor/leaflet/leaflet.js", html)
                self.assertNotIn("https://unpkg.com/leaflet", html)


if __name__ == "__main__":
    unittest.main()
