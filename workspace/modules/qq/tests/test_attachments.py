from __future__ import annotations

import io
import unittest
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from workspace.modules.qq.attachments import (
    extract_image_urls_from_segments,
    extract_shared_strings_from_archive,
    extract_text_from_worksheet,
    infer_suffix_from_bytes,
)


class QQAttachmentsTest(unittest.TestCase):
    def test_extracts_image_urls_from_segments(self) -> None:
        segments = [
            {"type": "text", "data": {"text": "irrelevant"}},
            {"type": "image", "data": {"url": "https://example.com/pic.png"}},
            {"type": "image", "data": {"file": "https://example.com/alternative.png"}},
        ]
        urls = extract_image_urls_from_segments(segments)
        self.assertEqual(urls, ["https://example.com/pic.png", "https://example.com/alternative.png"])

    def test_ignores_opaque_file_id(self) -> None:
        segments = [
            {"type": "image", "data": {"file": "ABC123"}},
            {"type": "image", "data": {"file": "https://example.com/pic.jpg"}},
        ]
        urls = extract_image_urls_from_segments(segments)
        self.assertEqual(urls, ["https://example.com/pic.jpg"])

    def test_infer_suffix_from_bytes_detects_png(self) -> None:
        png_header = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
        self.assertEqual(infer_suffix_from_bytes(png_header), ".png")

    def test_infer_suffix_from_bytes_detects_text(self) -> None:
        text_bytes = "hello\nworld".encode("utf-8")
        self.assertEqual(infer_suffix_from_bytes(text_bytes), ".txt")

    def test_infer_suffix_from_bytes_detects_non_latin_text(self) -> None:
        chinese_bytes = "你好，123".encode("utf-8")
        self.assertEqual(infer_suffix_from_bytes(chinese_bytes), ".txt")

    def test_infer_suffix_from_bytes_defaults_to_bin(self) -> None:
        binary = b"\xff\xfe\x00\xff"
        self.assertEqual(infer_suffix_from_bytes(binary), ".bin")

    def test_parse_shared_strings_from_archive(self) -> None:
        shared_strings_xml = """<?xml version="1.0" encoding="UTF-8"?>
            <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <si><t>Alpha</t></si>
                <si><t>Beta</t></si>
            </sst>
        """
        buffer = io.BytesIO()
        with ZipFile(buffer, "w") as archive:
            archive.writestr("xl/sharedStrings.xml", shared_strings_xml)
        buffer.seek(0)
        with ZipFile(buffer, "r") as archive:
            result = extract_shared_strings_from_archive(archive)
        self.assertEqual(result, ["Alpha", "Beta"])

    def test_extract_text_from_worksheet_with_shared_strings(self) -> None:
        xml = """<?xml version="1.0" encoding="UTF-8"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <sheetData>
                    <row>
                        <c t="s"><v>0</v></c>
                        <c t="s"><v>1</v></c>
                    </row>
                </sheetData>
            </worksheet>
        """
        root = ET.fromstring(xml)
        values = extract_text_from_worksheet(root, ["Pay", "Day"])
        self.assertEqual(values, ["Pay", "Day"])

    def test_extract_text_from_worksheet_with_numeric_cells(self) -> None:
        xml = """<?xml version="1.0" encoding="UTF-8"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <sheetData>
                    <row>
                        <c><v>42</v></c>
                        <c t="s"><v>0</v></c>
                    </row>
                </sheetData>
            </worksheet>
        """
        root = ET.fromstring(xml)
        values = extract_text_from_worksheet(root, ["Alpha"])
        self.assertEqual(values, ["42", "Alpha"])


if __name__ == "__main__":
    unittest.main()
